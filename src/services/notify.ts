import { Expo } from 'expo-server-sdk';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';

const expo = new Expo();

/** In-app notification + Expo push. Never throws. */
export async function notify(userId: string, type: string, title: string, body: string, data: Record<string, unknown> = {}) {
  try {
    await db.from('notifications').insert({ user_id: userId, type, title, body, data });
    const { data: p } = await db.from('profiles').select('expo_push_token').eq('id', userId).maybeSingle();
    const token = p?.expo_push_token;
    if (token && Expo.isExpoPushToken(token))
      await expo.sendPushNotificationsAsync([{ to: token, title, body, data, sound: 'default' }]);
  } catch (err) {
    logger.error({ err, userId, type }, 'notify failed');
  }
}
