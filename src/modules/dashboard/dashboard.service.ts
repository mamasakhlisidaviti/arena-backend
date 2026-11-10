import { Types } from 'mongoose';
import type { IUser } from '../users/user.model.js';
import { GameCategory } from '../categories/category.model.js';
import { Registration } from '../registrations/registration.model.js';
import { Tournament } from '../tournaments/tournament.model.js';

const DAY = 86400000;

function scopeFilter(actor: IUser): Record<string, unknown> {
  return actor.role === 'super_admin'
    ? {}
    : { organizerId: new Types.ObjectId(String(actor._id)) };
}

async function recentRegistrations(actor: IUser, limit = 8) {
  const scope = scopeFilter(actor);
  const tournamentIds = Object.keys(scope).length
    ? await Tournament.find(scope).distinct('_id')
    : null;
  return Registration.find(tournamentIds ? { tournamentId: { $in: tournamentIds } } : {})
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('participantInformation status registrationNumber createdAt tournamentId userId')
    .populate('tournamentId', 'title slug')
    .populate('userId', 'firstName lastName email');
}

export async function dashboardStats(actor: IUser) {
  const scope = scopeFilter(actor);
  const now = new Date();
  const tournamentIds = Object.keys(scope).length
    ? await Tournament.find(scope).distinct('_id')
    : null;
  const registrationMatch = tournamentIds ? { tournamentId: { $in: tournamentIds } } : {};

  const startDay = new Date(now);
  startDay.setHours(0, 0, 0, 0);
  startDay.setTime(startDay.getTime() - 13 * DAY);

  const [
    totalTournaments,
    upcoming,
    active,
    completed,
    participantsAgg,
    pendingRegistrations,
    approvedRegistrations,
    categories,
    recent,
    tournamentsByStatusRaw,
    registrationsByDayRaw,
    upcomingTournaments,
  ] = await Promise.all([
    Tournament.countDocuments(scope),
    Tournament.countDocuments({ ...scope, status: 'published', startDate: { $gte: now } }),
    Tournament.countDocuments({ ...scope, status: 'ongoing' }),
    Tournament.countDocuments({ ...scope, status: 'completed' }),
    Tournament.aggregate([
      { $match: scope },
      { $group: { _id: null, total: { $sum: '$currentParticipants' } } },
    ]),
    Registration.countDocuments({ ...registrationMatch, status: 'pending' }),
    Registration.countDocuments({ ...registrationMatch, status: 'approved' }),
    GameCategory.countDocuments({ isActive: true }),
    recentRegistrations(actor),
    Tournament.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Registration.aggregate([
      { $match: { ...registrationMatch, createdAt: { $gte: startDay } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Tournament.find({ ...scope, status: { $in: ['published', 'ongoing'] }, startDate: { $gte: now } })
      .sort({ startDate: 1 })
      .limit(5)
      .select('title slug startDate currentParticipants participantLimit coverImage'),
  ]);

  const byStatus: Record<string, number> = {
    draft: 0,
    published: 0,
    ongoing: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const row of tournamentsByStatusRaw as { _id: string; count: number }[]) {
    byStatus[row._id] = row.count;
  }

  const chart: { date: string; count: number }[] = [];
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(startDay.getTime() + index * DAY);
    const key = date.toISOString().slice(0, 10);
    const found = (registrationsByDayRaw as { _id: string; count: number }[]).find(
      (row) => row._id === key,
    );
    chart.push({ date: key, count: found?.count ?? 0 });
  }

  return {
    counts: {
      totalTournaments,
      upcoming,
      active,
      completed,
      totalParticipants: (participantsAgg as { total: number }[])[0]?.total ?? 0,
      pendingRegistrations,
      approvedRegistrations,
      categories,
    },
    charts: {
      registrationsByDay: chart,
      tournamentsByStatus: byStatus,
    },
    recentRegistrations: recent,
    upcomingTournaments,
  };
}

export async function dashboardRecentRegistrations(actor: IUser, limit = 10) {
  return recentRegistrations(actor, limit);
}
