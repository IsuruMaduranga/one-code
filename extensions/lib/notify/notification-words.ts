/**
 * The notification words in force for lib/notify/notifications.ts, which
 * every background feature shares: the base's words (notifications-text.ts)
 * built for this session's tools and the profile's part. Fails closed
 * (`requireText`) without that part: the frames are part of every session.
 */

import { wordsInForce } from "../profile/live-words.ts";
import { type NotificationWords, notificationText } from "./notifications-text.ts";

// One object per live set and profile group: the frame patterns are cached on it (notifications.ts).
export const notificationWords: () => NotificationWords = wordsInForce("notifications", notificationText);
