import { ApiError } from '../../../common/errors.js';
import type { ParticipantInformation } from '../../registrations/registration.model.js';
import type { GameModule } from './game-module.js';

const TIME_CONTROLS: Record<string, { initialMinutes: number; incrementSeconds: number }> = {
  classical: { initialMinutes: 90, incrementSeconds: 30 },
  rapid: { initialMinutes: 10, incrementSeconds: 5 },
  blitz: { initialMinutes: 5, incrementSeconds: 3 },
  bullet: { initialMinutes: 2, incrementSeconds: 1 },
  chess960: { initialMinutes: 10, incrementSeconds: 5 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integer(raw: unknown, fallback: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw ApiError.unprocessable(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export const chessModule: GameModule = {
  slug: 'chess',
  registrationPrefix: 'CHS',

  defaultGameSettings(tournamentType: string): Record<string, unknown> {
    return {
      timeControl: TIME_CONTROLS[tournamentType] ?? TIME_CONTROLS['classical'],
      rounds: 9,
    };
  },

  validateGameSettings(input) {
    const raw = isRecord(input.gameSettings) ? input.gameSettings : {};
    const timeControl = isRecord(raw['timeControl']) ? raw['timeControl'] : {};
    const fallback = TIME_CONTROLS[input.tournamentType] ?? TIME_CONTROLS['classical'];

    const initialMinutes = integer(
      timeControl['initialMinutes'],
      fallback.initialMinutes,
      1,
      600,
      'Initial minutes',
    );
    const incrementSeconds = integer(
      timeControl['incrementSeconds'],
      fallback.incrementSeconds,
      0,
      180,
      'Increment seconds',
    );
    const rounds = integer(raw['rounds'], 9, 1, 30, 'Rounds');

    return { timeControl: { initialMinutes, incrementSeconds }, rounds };
  },

  validateParticipant(info: ParticipantInformation) {
    if (info.rating !== undefined && info.rating !== null) {
      const rating = Number(info.rating);
      if (!Number.isFinite(rating) || rating < 0 || rating > 4000) {
        throw ApiError.unprocessable('Chess rating must be between 0 and 4000');
      }
    }
    if (info.fideId && !/^[0-9]{3,10}$/.test(info.fideId)) {
      throw ApiError.unprocessable('FIDE ID must contain 3 to 10 digits');
    }
  },
};

const genericModule: GameModule = {
  slug: 'generic',
  registrationPrefix: 'REG',
  defaultGameSettings() {
    return {};
  },
  validateGameSettings(input) {
    return isRecord(input.gameSettings) ? input.gameSettings : {};
  },
  validateParticipant() {
    /* core participant validation is shared */
  },
};

const registry = new Map<string, GameModule>([[chessModule.slug, chessModule]]);

export function registerGameModule(module: GameModule): void {
  registry.set(module.slug, module);
}

export function getGameModule(categorySlug: string): GameModule {
  return registry.get(categorySlug) ?? genericModule;
}
