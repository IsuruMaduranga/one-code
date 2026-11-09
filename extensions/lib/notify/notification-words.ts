/**
 * The profile's notification words for lib/notify/notifications.ts, which every
 * background feature shares. Fails closed (`requireText`) without them: the
 * frames are part of every session.
 */

import type { NotificationsText } from "./notifications-text.ts";
import { requireText } from "../profile/profile.ts";

export const notificationWords = (): NotificationsText => requireText("notifications");
