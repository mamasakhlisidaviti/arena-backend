import type { ParticipantInformation } from '../../registrations/registration.model.js';

export interface GameSettingsInput {
  tournamentType: string;
  format: string;
  gameSettings: Record<string, unknown>;
}

export interface GameModule {
  slug: string;
  registrationPrefix: string;
  validateGameSettings(input: GameSettingsInput): Record<string, unknown>;
  validateParticipant(info: ParticipantInformation): void;
  defaultGameSettings(tournamentType: string): Record<string, unknown>;
}
