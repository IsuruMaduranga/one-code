/**
 * The notification words in force for lib/notify/notifications.ts, which
 * every background feature shares: the base's words (notifications-text.ts)
 * built for this session's tools and the profile's part. Fails closed
 * (`requireText`) without that part: the frames are part of every session.
 */

import { activeProfile, requireText } from "../profile/profile.ts";
import { type NotificationWords, notificationText } from "./notifications-text.ts";

const built = new WeakMap<object, NotificationWords>();

export function notificationWords(): NotificationWords {
	const product = requireText("notifications");
	let words = built.get(product);
	if (!words) built.set(product, (words = notificationText(activeProfile().live, product)));
	return words;
}
