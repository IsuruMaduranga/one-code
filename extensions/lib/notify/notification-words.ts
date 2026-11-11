/**
 * The notification words in force for lib/notify/notifications.ts, which
 * every background feature shares: the base's words (notifications-text.ts)
 * built for this session's tools and the profile's part. Fails closed
 * (`requireText`) without that part: the frames are part of every session.
 */

import { memoOn } from "../core/text-spans.ts";
import { activeProfile, requireText } from "../profile/profile.ts";
import { type NotificationsText, type NotificationWords, notificationText } from "./notifications-text.ts";

// One object per profile group: the frame patterns are cached on it (notifications.ts).
const built = memoOn((product: NotificationsText) => notificationText(activeProfile().live, product));

export const notificationWords = (): NotificationWords => built(requireText("notifications"));
