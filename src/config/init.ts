import { RefreshToken } from '../modules/auth/refresh-token.model.js';
import { GameCategory } from '../modules/categories/category.model.js';
import { Notification } from '../modules/notifications/notification.model.js';
import { Registration } from '../modules/registrations/registration.model.js';
import { Setting } from '../modules/settings/setting.model.js';
import { Tournament } from '../modules/tournaments/tournament.model.js';
import { User } from '../modules/users/user.model.js';

/** Ensures unique indexes (duplicate/capacity guarantees) exist before serving traffic. */
export async function initModels(): Promise<void> {
  await Promise.all([
    User.init(),
    RefreshToken.init(),
    GameCategory.init(),
    Tournament.init(),
    Registration.init(),
    Notification.init(),
    Setting.init(),
  ]);
}
