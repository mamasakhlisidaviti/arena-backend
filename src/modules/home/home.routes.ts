import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { sendSuccess } from '../../common/response.js';
import { env } from '../../config/env.js';
import { GameCategory } from '../categories/category.model.js';
import { Setting } from '../settings/setting.model.js';
import { Tournament } from '../tournaments/tournament.model.js';

const now = () => new Date();

export const homeRouter = Router();

homeRouter.get(
  '/home',
  asyncHandler(async (_req, res) => {
    const timestamp = now();
    const [settings, categories, featuredRaw, upcoming, recent, statsAgg] = await Promise.all([
      Setting.findOneAndUpdate(
        { key: 'platform' },
        { $setOnInsert: { key: 'platform' } },
        { new: true, upsert: true },
      ),
      GameCategory.find({ isActive: true }).sort({ displayOrder: 1 }).limit(8),
      Tournament.find({
        status: { $in: ['published', 'ongoing'] },
        publishedAt: { $ne: null },
        isFeatured: true,
        startDate: { $gte: timestamp },
      })
        .sort({ startDate: 1 })
        .limit(3)
        .populate('categoryId', 'name slug icon')
        .populate('organizerId', 'firstName lastName')
        .select('-description -rules -prizes -seo -contact -gameSettings'),
      Tournament.find({
        status: 'published',
        publishedAt: { $ne: null },
        startDate: { $gte: timestamp },
      })
        .sort({ startDate: 1 })
        .limit(6)
        .populate('categoryId', 'name slug icon')
        .populate('organizerId', 'firstName lastName')
        .select('-description -rules -prizes -seo -contact -gameSettings'),
      Tournament.find({ status: 'published', publishedAt: { $ne: null } })
        .sort({ publishedAt: -1 })
        .limit(3)
        .populate('categoryId', 'name slug icon')
        .populate('organizerId', 'firstName lastName')
        .select('-description -rules -prizes -seo -contact -gameSettings'),
      Tournament.aggregate([
        { $match: { status: { $in: ['published', 'ongoing', 'completed'] }, publishedAt: { $ne: null } } },
        {
          $group: {
            _id: null,
            tournaments: { $sum: 1 },
            participants: { $sum: '$currentParticipants' },
          },
        },
      ]),
    ]);

    const featured = [...featuredRaw];
    if (featured.length < 3) {
      for (const item of upcoming) {
        if (featured.length >= 3) {
          break;
        }
        if (!featured.some((existing) => String(existing._id) === String(item._id))) {
          featured.push(item);
        }
      }
    }
    const aggregate = (statsAgg as { tournaments: number; participants: number }[])[0];

    sendSuccess(res, {
      settings,
      categories,
      featured,
      upcoming,
      recent,
      stats: {
        tournaments: aggregate?.tournaments ?? 0,
        participants: aggregate?.participants ?? 0,
        categories: categories.length,
      },
    });
  }),
);

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      "'": '&apos;',
      '"': '&quot;',
    };
    return map[char] ?? char;
  });
}

export const seoRouter = Router();

seoRouter.get(
  '/sitemap.xml',
  asyncHandler(async (_req, res) => {
    const base = env.publicSiteUrl;
    const tournaments = await Tournament.find({
      status: { $in: ['published', 'ongoing', 'completed'] },
      publishedAt: { $ne: null },
    })
      .select('slug updatedAt')
      .sort({ updatedAt: -1 })
      .limit(5000);

    const urls = [
      { loc: `${base}/`, priority: '1.0', changefreq: 'daily' },
      { loc: `${base}/tournaments`, priority: '0.9', changefreq: 'daily' },
      ...tournaments.map((item) => ({
        loc: `${base}/tournaments/${item.slug}`,
        lastmod: item.updatedAt.toISOString(),
        priority: '0.8',
        changefreq: 'weekly',
      })),
    ];

    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map(
        (entry) =>
          `  <url><loc>${escapeXml(entry.loc)}</loc>${'lastmod' in entry && entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''}<changefreq>${entry.changefreq}</changefreq><priority>${entry.priority}</priority></url>`,
      )
      .join('\n')}\n</urlset>`;
    res.type('application/xml').send(body);
  }),
);

seoRouter.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /login\nDisallow: /register\n\nSitemap: ${env.publicSiteUrl}/sitemap.xml\n`);
});
