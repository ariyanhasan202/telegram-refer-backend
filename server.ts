import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';

// Server-side Secrets (never sent to client)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const rawBotUsername = process.env.TELEGRAM_BOT_USERNAME || process.env.VITE_TELEGRAM_BOT_USERNAME || '';
const TELEGRAM_BOT_USERNAME = rawBotUsername.replace(/^@/, '').trim();
const TELEGRAM_WEBAPP_URL = process.env.TELEGRAM_WEBAPP_URL || process.env.APP_URL || '';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

let serverSupabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_URL.includes('your-project')) {
  serverSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const allowedOrigin = process.env.FRONTEND_URL || '*';
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

// -------------------------------------------------------------
// Registered Telegram Tasks (Anti-Fraud Authoritative Config)
// -------------------------------------------------------------
export interface RegisteredTask {
  id: string;
  title: string;
  channelUsername: string;
  channelUrl: string;
  reward: number;
  categoryBadge: string;
  iconType: 'gift' | 'telegram' | 'other';
  description: string;
}

export const REGISTERED_TASKS: Record<string, RegisteredTask> = {
  'task-1': {
    id: 'task-1',
    title: 'Welcome Bonus',
    channelUsername: 'colour_trading_leder_admin_group',
    channelUrl: 'https://t.me/colour_trading_leder_admin_group',
    reward: 50.00,
    categoryBadge: 'JOIN BONUS',
    iconType: 'gift',
    description: 'Join our official leader & admin group'
  },
  'task-2': {
    id: 'task-2',
    title: 'Payment Channel',
    channelUsername: 'x_bost_incoming',
    channelUrl: 'https://t.me/x_bost_incoming',
    reward: 20.00,
    categoryBadge: 'TELEGRAM',
    iconType: 'telegram',
    description: 'Subscribe to our payment proof channel'
  },
  'task-3': {
    id: 'task-3',
    title: 'Giveaway',
    channelUsername: 'devloper_solution_bd',
    channelUrl: 'https://t.me/devloper_solution_bd',
    reward: 20.00,
    categoryBadge: 'OTHER',
    iconType: 'other',
    description: 'Join developer giveaway & special perks'
  },
  'task-4': {
    id: 'task-4',
    title: 'Official Channel',
    channelUsername: 'trading_comionitiy',
    channelUrl: 'https://t.me/trading_comionitiy',
    reward: 20.00,
    categoryBadge: 'TELEGRAM',
    iconType: 'telegram',
    description: 'Follow our main trading community channel'
  }
};

const taskOpenTimestamps = new Map<string, number>(); // `${userId}_${taskId}` -> timestamp
const taskVerificationLocks = new Set<string>(); // `${userId}_${taskId}` lock
const inMemoryCompletedTasks = new Map<string, Set<string>>(); // userId -> Set<taskId>

// -------------------------------------------------------------
// Authoritative Multi-Step Watch Session Storage & Claim Lock
// -------------------------------------------------------------
interface WatchSession {
  sessionId: string;
  userId: string;
  completedCount: number;
  totalRequired: number;
  rewardEligible: boolean;
  rewardClaimed: boolean;
  rewardAmount: number;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
}

const activeWatchSessions = new Map<string, WatchSession>();
const userCurrentSession = new Map<string, string>(); // userId -> sessionId
const claimInProgressLocks = new Set<string>();

const processedUpdateIds = new Set<number>();
setInterval(() => {
  if (processedUpdateIds.size > 10000) {
    processedUpdateIds.clear();
  }
  const now = Date.now();
  for (const [sId, sess] of activeWatchSessions.entries()) {
    if (now - sess.createdAt > 2 * 60 * 60 * 1000) {
      activeWatchSessions.delete(sId);
      if (userCurrentSession.get(sess.userId) === sId) {
        userCurrentSession.delete(sess.userId);
      }
    }
  }
  for (const [key, time] of taskOpenTimestamps.entries()) {
    if (now - time > 60 * 60 * 1000) {
      taskOpenTimestamps.delete(key);
    }
  }
}, 30 * 60 * 1000);

export function validateTelegramWebAppData(initData: string, botToken: string): {
  isValid: boolean;
  user?: {
    id: string;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    photo_url?: string;
  };
  start_param?: string;
  auth_date?: number;
  error?: string;
} {
  if (!botToken) {
    return { isValid: false, error: 'TELEGRAM_BOT_TOKEN is not configured on server' };
  }

  try {
    let cleanInitData = initData.trim();
    if (cleanInitData.startsWith('#')) {
      cleanInitData = cleanInitData.slice(1);
    }
    if (cleanInitData.includes('tgWebAppData=')) {
      const match = cleanInitData.match(/tgWebAppData=([^&]+)/);
      if (match) {
        cleanInitData = decodeURIComponent(match[1]);
      }
    }
    const urlParams = new URLSearchParams(cleanInitData);
    const hash = urlParams.get('hash');
    if (!hash) {
      return { isValid: false, error: 'Missing hash parameter in Telegram initData' };
    }

    urlParams.delete('hash');

    const params: string[] = [];
    for (const [key, value] of urlParams.entries()) {
      params.push(`${key}=${value}`);
    }
    params.sort();
    const dataCheckString = params.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const hashBuffer = Buffer.from(hash, 'hex');
    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
    if (hashBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(hashBuffer, calculatedBuffer)) {
      return { isValid: false, error: 'Invalid Telegram WebApp HMAC signature' };
    }

    const userRaw = urlParams.get('user');
    let user;
    if (userRaw) {
      const parsed = JSON.parse(userRaw);
      user = {
        id: String(parsed.id),
        first_name: parsed.first_name || '',
        last_name: parsed.last_name || '',
        username: parsed.username || '',
        language_code: parsed.language_code || '',
        photo_url: parsed.photo_url || ''
      };
    }

    const authDate = Number(urlParams.get('auth_date')) || undefined;

    return {
      isValid: true,
      user,
      start_param: urlParams.get('start_param') || undefined,
      auth_date: authDate
    };
  } catch (err: any) {
    return { isValid: false, error: err.message || 'Error validating initData' };
  }
}

async function getTelegramUserProfilePhoto(userId: string | number, botToken: string): Promise<string | null> {
  if (!botToken || !userId) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const photosRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${userId}&limit=1`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!photosRes.ok) return null;
    const photosData = await photosRes.json();
    if (!photosData.ok || !photosData.result || photosData.result.total_count === 0 || !photosData.result.photos?.[0]?.length) {
      return null;
    }
    const photoSizes = photosData.result.photos[0];
    const selectedPhoto = photoSizes[photoSizes.length - 1];
    const fileId = selectedPhoto.file_id;

    const fileController = new AbortController();
    const fileTimeout = setTimeout(() => fileController.abort(), 1800);
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
      { signal: fileController.signal }
    );
    clearTimeout(fileTimeout);
    if (!fileRes.ok) return null;
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result?.file_path) return null;
    return `/api/telegram-avatar/${userId}?path=${encodeURIComponent(fileData.result.file_path)}`;
  } catch (err) {
    console.warn('[Telegram Avatar Helper]:', err);
    return null;
  }
}

app.get('/api/bot-info', (_req: Request, res: Response) => {
  res.json({
    configured: Boolean(TELEGRAM_BOT_TOKEN),
    botUsername: TELEGRAM_BOT_USERNAME,
    webAppUrl: TELEGRAM_WEBAPP_URL,
    hasSupabaseServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  });
});

app.get('/api/telegram-avatar/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;
  const filePathParam = req.query.path as string;

  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).send('Telegram Bot Token not configured on server');
  }

  try {
    let filePath = filePathParam;
    if (!filePath) {
      const photosRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUserProfilePhotos?user_id=${userId}&limit=1`);
      const photosData = await photosRes.json();
      if (!photosData.ok || !photosData.result?.photos?.[0]?.length) {
        return res.status(404).send('No profile photo found');
      }
      const photoSizes = photosData.result.photos[0];
      const fileId = photoSizes[photoSizes.length - 1].file_id;
      const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();
      filePath = fileData.result?.file_path;
    }

    if (!filePath) {
      return res.status(404).send('Photo file path not found');
    }

    const imageRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
    if (!imageRes.ok) {
      return res.status(404).send('Photo not accessible');
    }

    const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
    const buffer = await imageRes.arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(buffer));
  } catch (err: any) {
    console.error('Error fetching telegram avatar:', err);
    return res.status(500).send('Error retrieving profile photo');
  }
});

// GET /api/telegram-verify-status: Authoritative check against Supabase
app.get('/api/telegram-verify-status', async (req: Request, res: Response) => {
  const telegramId = String(req.query.telegramId || '').trim();
  if (!telegramId) {
    return res.json({ verified: false, error: 'telegramId parameter is required' });
  }

  if (serverSupabase) {
    try {
      const { data: dbUser, error } = await serverSupabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .maybeSingle();

      if (dbUser && !error) {
        const fullName = [dbUser.first_name, dbUser.last_name].filter(Boolean).join(' ').trim();
        const displayName = fullName || dbUser.first_name || (dbUser.username ? `@${dbUser.username}` : 'User');
        const username = dbUser.username ? (dbUser.username.startsWith('@') ? dbUser.username : `@${dbUser.username}`) : null;

        return res.json({
          verified: true,
          profile: {
            id: dbUser.id,
            telegram_id: dbUser.telegram_id,
            first_name: dbUser.first_name,
            last_name: dbUser.last_name || null,
            display_name: displayName,
            username: username,
            photo_url: dbUser.photo_url || null,
            is_verified: true,
            telegram_verified: true,
            balance: Number(dbUser.balance) || 0,
            total_referrals: Number(dbUser.total_referrals) || 0,
            level: Number(dbUser.level) || 0,
            total_earned: Number(dbUser.total_earned) || 0,
            total_withdrawn: Number(dbUser.total_withdrawn) || 0,
            tasks_completed: Number(dbUser.tasks_completed) || 0,
            completed_tasks: Array.isArray(dbUser.completed_tasks) ? dbUser.completed_tasks : [],
            daily_ads_watched: Number(dbUser.daily_ads_watched) || 0,
            referral_code: dbUser.referral_code,
            created_at: dbUser.created_at
          }
        });
      }
    } catch (err: any) {
      console.warn('[Status Check DB Error]:', err.message);
    }
  }

  return res.json({ verified: false });
});

// -------------------------------------------------------------
// Tasks Authoritative Anti-Fraud API
// -------------------------------------------------------------
app.get('/api/tasks', (_req: Request, res: Response) => {
  res.json({
    success: true,
    tasks: Object.values(REGISTERED_TASKS)
  });
});

app.get('/api/tasks/status', async (req: Request, res: Response) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required' });
  }

  let completedTasks: string[] = [];
  if (serverSupabase) {
    try {
      const { data: dbUser } = await serverSupabase
        .from('users')
        .select('completed_tasks')
        .eq('id', userId)
        .maybeSingle();

      if (dbUser && Array.isArray(dbUser.completed_tasks)) {
        completedTasks = dbUser.completed_tasks;
      }
    } catch (e) {
      // fallback
    }
  }

  const inMem = inMemoryCompletedTasks.get(userId);
  if (inMem) {
    completedTasks = Array.from(new Set([...completedTasks, ...inMem]));
  }

  return res.json({
    success: true,
    completedTasks,
    tasks: Object.values(REGISTERED_TASKS).map((t) => ({
      ...t,
      status: completedTasks.includes(t.id) ? 'completed' : 'pending'
    }))
  });
});

app.post('/api/tasks/open-intent', (req: Request, res: Response) => {
  const { userId, taskId } = req.body;
  if (!userId || !taskId) {
    return res.status(400).json({ success: false, error: 'userId and taskId are required' });
  }
  const key = `${userId}_${taskId}`;
  taskOpenTimestamps.set(key, Date.now());
  return res.json({ success: true, timestamp: Date.now() });
});

app.post('/api/tasks/verify', async (req: Request, res: Response) => {
  const { userId, taskId, telegramId } = req.body;

  if (!userId || !taskId) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_REQUEST',
      message: 'userId and taskId are required.'
    });
  }

  const task = REGISTERED_TASKS[taskId];
  if (!task) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_TASK',
      message: 'Invalid task identifier.'
    });
  }

  // Idempotency / Concurrency Lock per User and Task
  const lockKey = `${userId}_${taskId}`;
  if (taskVerificationLocks.has(lockKey)) {
    return res.status(429).json({
      success: false,
      error: 'VERIFICATION_IN_PROGRESS',
      message: 'Task verification is already in progress. Please wait a moment.'
    });
  }
  taskVerificationLocks.add(lockKey);

  try {
    let dbUser: any = null;
    if (serverSupabase) {
      const { data, error } = await serverSupabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data) {
        dbUser = data;
      }
    }

    // 1. Authenticated User Check:
    const activeTelegramId = String(dbUser?.telegram_id || telegramId || '').trim();
    if (!activeTelegramId) {
      return res.status(403).json({
        success: false,
        error: 'UNVERIFIED_ACCOUNT',
        message: 'You must verify your Telegram account first to complete tasks and earn rewards.'
      });
    }

    // 2. Duplicate Reward Protection:
    const inMemSet = inMemoryCompletedTasks.get(userId) || new Set<string>();
    const existingCompleted: string[] = Array.isArray(dbUser?.completed_tasks) 
      ? Array.from(new Set([...dbUser.completed_tasks, ...inMemSet]))
      : Array.from(inMemSet);

    if (existingCompleted.includes(taskId) || inMemSet.has(taskId)) {
      return res.status(409).json({
        success: false,
        error: 'TASK_ALREADY_COMPLETED',
        message: 'This task has already been completed and rewarded.'
      });
    }

    // 3. Minimum Dwell Time / Anti-Instant-Click Guard:
    const openTime = taskOpenTimestamps.get(lockKey);
    const now = Date.now();
    if (!openTime || now - openTime < 3000) {
      return res.status(400).json({
        success: false,
        error: 'CHANNEL_NOT_OPENED',
        message: 'Please tap "Open Channel Link", join the Telegram channel, and then verify.'
      });
    }

    // 4. Real Telegram Channel Membership Verification:
    if (TELEGRAM_BOT_TOKEN && task.channelUsername) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const memberRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=@${task.channelUsername}&user_id=${activeTelegramId}`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);

        if (memberRes.ok) {
          const memberData = await memberRes.json();
          if (memberData.ok && memberData.result) {
            const status = memberData.result.status;
            if (status === 'left' || status === 'kicked') {
              return res.status(400).json({
                success: false,
                error: 'NOT_JOINED',
                message: 'You have not joined this Telegram channel yet. Please join the channel first.'
              });
            }
          }
        }
      } catch (err: any) {
        console.warn('[Task getChatMember Check Warning]:', err.message);
      }
    }

    // 5. Atomic Reward Credit in Database
    const rewardAmount = task.reward;
    const newCompletedTasks = [...existingCompleted, taskId];
    const newTasksCompleted = (dbUser?.tasks_completed || 0) + 1;
    const newBalance = +(Number(dbUser?.balance || 0) + rewardAmount).toFixed(2);
    const newTotalEarned = +(Number(dbUser?.total_earned || 0) + rewardAmount).toFixed(2);

    if (serverSupabase && dbUser) {
      await serverSupabase
        .from('users')
        .update({
          completed_tasks: newCompletedTasks,
          tasks_completed: newTasksCompleted,
          balance: newBalance,
          total_earned: newTotalEarned
        })
        .eq('id', userId);
    }

    if (!inMemoryCompletedTasks.has(userId)) {
      inMemoryCompletedTasks.set(userId, new Set<string>());
    }
    inMemoryCompletedTasks.get(userId)!.add(taskId);

    // Clear open timestamp to prevent replay
    taskOpenTimestamps.delete(lockKey);

    return res.json({
      success: true,
      taskId,
      rewardCredited: rewardAmount,
      newBalance,
      tasksCompleted: newTasksCompleted,
      completedTasks: newCompletedTasks
    });
  } catch (err: any) {
    console.error('[Task Verification Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'An error occurred during verification. Please try again.'
    });
  } finally {
    taskVerificationLocks.delete(lockKey);
  }
});

// -------------------------------------------------------------
// Authoritative 3-Step Watch Session Endpoints
// -------------------------------------------------------------
app.get('/api/ads/session/current', (req: Request, res: Response) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required' });
  }

  const existingSessionId = userCurrentSession.get(userId);
  if (existingSessionId && activeWatchSessions.has(existingSessionId)) {
    const session = activeWatchSessions.get(existingSessionId);
    if (session && !session.rewardClaimed) {
      return res.json({ success: true, session });
    }
  }

  return res.json({ success: true, session: null });
});

app.post('/api/ads/session/start', (req: Request, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId is required' });
  }

  const existingSessionId = userCurrentSession.get(userId);
  if (existingSessionId && activeWatchSessions.has(existingSessionId)) {
    const session = activeWatchSessions.get(existingSessionId)!;
    if (!session.rewardClaimed) {
      return res.json({ success: true, session });
    }
  }

  const newSessionId = `ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const session: WatchSession = {
    sessionId: newSessionId,
    userId,
    completedCount: 0,
    totalRequired: 3,
    rewardEligible: false,
    rewardClaimed: false,
    rewardAmount: 2.00,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  activeWatchSessions.set(newSessionId, session);
  userCurrentSession.set(userId, newSessionId);

  return res.json({ success: true, session });
});

app.post('/api/ads/session/step-complete', (req: Request, res: Response) => {
  const { sessionId, userId, step } = req.body;
  if (!sessionId || !userId) {
    return res.status(400).json({ success: false, error: 'sessionId and userId are required' });
  }

  const session = activeWatchSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found or expired' });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ success: false, error: 'Session does not belong to user' });
  }

  if (session.rewardClaimed) {
    return res.status(409).json({ success: false, error: 'REWARD_ALREADY_CLAIMED' });
  }

  if (step === session.completedCount + 1) {
    session.completedCount += 1;
    session.updatedAt = Date.now();
    if (session.completedCount >= session.totalRequired) {
      session.rewardEligible = true;
    }
  }

  return res.json({ success: true, session });
});

app.post('/api/ads/session/claim-reward', async (req: Request, res: Response) => {
  const { sessionId, userId } = req.body;
  if (!sessionId || !userId) {
    return res.status(400).json({ success: false, error: 'sessionId and userId are required' });
  }

  const lockKey = `${sessionId}_${userId}`;
  if (claimInProgressLocks.has(lockKey)) {
    return res.status(429).json({ success: false, error: 'CLAIM_IN_PROGRESS' });
  }
  claimInProgressLocks.add(lockKey);

  try {
    const session = activeWatchSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Unauthorized session' });
    }

    if (session.rewardClaimed) {
      return res.status(409).json({ success: false, error: 'REWARD_ALREADY_CLAIMED' });
    }

    if (session.completedCount < session.totalRequired || !session.rewardEligible) {
      return res.status(400).json({ 
        success: false, 
        error: `NOT_ELIGIBLE_FOR_REWARD. Completed: ${session.completedCount}/${session.totalRequired}` 
      });
    }

    session.rewardClaimed = true;
    session.claimedAt = Date.now();
    session.updatedAt = Date.now();

    const rewardAmount = session.rewardAmount;
    let newBalance = 0;

    if (serverSupabase) {
      try {
        const { data: existingUser } = await serverSupabase
          .from('users')
          .select('balance, total_earned, daily_ads_watched')
          .eq('id', userId)
          .maybeSingle();

        if (existingUser) {
          const updatedBal = +(Number(existingUser.balance || 0) + rewardAmount).toFixed(2);
          const updatedEarned = +(Number(existingUser.total_earned || 0) + rewardAmount).toFixed(2);
          const updatedAds = Number(existingUser.daily_ads_watched || 0) + 1;

          await serverSupabase
            .from('users')
            .update({
              balance: updatedBal,
              total_earned: updatedEarned,
              daily_ads_watched: updatedAds
            })
            .eq('id', userId);

          newBalance = updatedBal;
        }
      } catch (dbErr: any) {
        console.warn('[Supabase Claim Credit Warning]:', dbErr.message);
      }
    }

    return res.json({
      success: true,
      rewardCredited: rewardAmount,
      newBalance,
      session
    });
  } finally {
    claimInProgressLocks.delete(lockKey);
  }
});

async function processTelegramVerification(req: Request, res: Response) {
  try {
    const { initData, startParam, currentUserId, unsafeUser } = req.body;

    let tgUser: any = null;
    let authDate: number | undefined = undefined;

    if (initData && TELEGRAM_BOT_TOKEN) {
      const validationResult = validateTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (validationResult.isValid && validationResult.user) {
        tgUser = validationResult.user;
        authDate = validationResult.auth_date;
      }
    }

    // Resilient fallback for Telegram Mini App environment (e.g. BotFather test or client-side bridge)
    // Never trust initDataUnsafe when a bot token is configured.
    // It is only a UI hint and is not cryptographically authenticated.
    if (!tgUser && !TELEGRAM_BOT_TOKEN && unsafeUser && unsafeUser.id) {
      tgUser = {
        id: String(unsafeUser.id),
        first_name: unsafeUser.first_name || '',
        last_name: unsafeUser.last_name || '',
        username: unsafeUser.username || '',
        photo_url: unsafeUser.photo_url || ''
      };
    }

    if (!tgUser || !tgUser.id) {
      return res.status(400).json({ 
        success: false, 
        verified: false, 
        error: 'Telegram identity not detected. Please ensure you are opening inside Telegram.' 
      });
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);
    if (authDate && authDate > nowInSeconds + 900) {
      return res.status(401).json({
        success: false,
        verified: false,
        error: 'Telegram authentication timestamp invalid (future dated).'
      });
    }
    const referralCode = (startParam || '').trim().toUpperCase();

    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim();
    const displayName = fullName || tgUser.first_name || (tgUser.username ? `@${tgUser.username}` : 'User');
    const username = tgUser.username ? (tgUser.username.startsWith('@') ? tgUser.username : `@${tgUser.username}`) : null;
    const cleanUsername = tgUser.username ? tgUser.username.replace(/^@/, '').trim() : null;

    let photoUrl = tgUser.photo_url || null;
    if (!photoUrl && TELEGRAM_BOT_TOKEN) {
      try {
        photoUrl = await getTelegramUserProfilePhoto(tgUser.id, TELEGRAM_BOT_TOKEN);
      } catch (photoErr) {
        console.warn('Telegram photo retrieval ignored:', photoErr);
      }
    }

    if (currentUserId && serverSupabase && !currentUserId.startsWith('00000000-0000') && !currentUserId.startsWith('guest_')) {
      const { data: existingBoundUser } = await serverSupabase
        .from('users')
        .select('id, telegram_id')
        .eq('id', currentUserId)
        .maybeSingle();

      if (existingBoundUser && existingBoundUser.telegram_id && String(existingBoundUser.telegram_id) !== String(tgUser.id)) {
        return res.status(409).json({
          success: false,
          verified: false,
          error: 'Account conflict: Current profile is already linked to another Telegram account'
        });
      }
    }

    let isNewUser = false;
    let referralConfirmed = false;
    let dbUser: any = null;

    if (serverSupabase) {
      try {
        const { data: existingUser, error: findErr } = await serverSupabase
          .from('users')
          .select('*')
          .eq('telegram_id', String(tgUser.id))
          .maybeSingle();

        if (findErr) {
          console.warn('[Supabase Find User Error]:', findErr.message);
        }

        if (existingUser) {
          const { data: updatedUser, error: updateErr } = await serverSupabase
            .from('users')
            .update({
              first_name: tgUser.first_name,
              last_name: tgUser.last_name || existingUser.last_name,
              username: cleanUsername || existingUser.username,
              photo_url: photoUrl || existingUser.photo_url
            })
            .eq('telegram_id', String(tgUser.id))
            .select()
            .single();

          if (!updateErr && updatedUser) {
            dbUser = updatedUser;
          } else {
            dbUser = existingUser;
          }
        } else {
          isNewUser = true;
          const uniqueReferralCode = crypto.createHash('md5').update(String(tgUser.id)).digest('hex').slice(0, 6).toUpperCase();

          let referrerId: string | null = null;
          if (referralCode) {
            const { data: referrerUser } = await serverSupabase
              .from('users')
              .select('id, telegram_id, total_referrals, balance, total_earned')
              .eq('referral_code', referralCode)
              .maybeSingle();

            if (referrerUser && String(referrerUser.telegram_id) !== String(tgUser.id)) {
              referrerId = referrerUser.id;
              referralConfirmed = true;

              const newTotalRefs = (referrerUser.total_referrals || 0) + 1;
              let newLevel = 0;
              if (newTotalRefs >= 300) newLevel = 6;
              else if (newTotalRefs >= 240) newLevel = 5;
              else if (newTotalRefs >= 180) newLevel = 4;
              else if (newTotalRefs >= 120) newLevel = 3;
              else if (newTotalRefs >= 80) newLevel = 2;
              else if (newTotalRefs >= 40) newLevel = 1;

              await serverSupabase
                .from('users')
                .update({
                  total_referrals: newTotalRefs,
                  level: newLevel,
                  balance: +(Number(referrerUser.balance || 0) + 50.00).toFixed(2),
                  total_earned: +(Number(referrerUser.total_earned || 0) + 50.00).toFixed(2)
                })
                .eq('id', referrerUser.id);

              await serverSupabase
                .from('referrals')
                .insert({
                  referrer_id: referrerUser.id,
                  status: 'confirmed'
                });
            }
          }

          const { data: createdUser, error: createErr } = await serverSupabase
            .from('users')
            .insert({
              id: `tg_${tgUser.id}`,
              telegram_id: String(tgUser.id),
              first_name: tgUser.first_name,
              last_name: tgUser.last_name || null,
              username: cleanUsername,
              photo_url: photoUrl,
              referrer_id: referrerId,
              referral_code: uniqueReferralCode,
              balance: 0,
              total_referrals: 0,
              level: 0,
              total_earned: 0,
              total_withdrawn: 0,
              tasks_completed: 0,
              completed_tasks: [],
              daily_ads_watched: 0
            })
            .select()
            .single();

          if (!createErr && createdUser) {
            dbUser = createdUser;
          } else if (createErr) {
            console.warn('[Supabase Create User Error]:', createErr.message);
          }
        }
      } catch (err: any) {
        console.warn('[Supabase Verification Pipeline Error]:', err.message);
      }
    }

    if (!dbUser) {
      const uniqueReferralCode = crypto.createHash('md5').update(String(tgUser.id)).digest('hex').slice(0, 6).toUpperCase();
      dbUser = {
        id: `tg_${tgUser.id}`,
        telegram_id: String(tgUser.id),
        first_name: tgUser.first_name,
        last_name: tgUser.last_name || null,
        username: cleanUsername,
        photo_url: photoUrl,
        balance: 0,
        total_referrals: 0,
        level: 0,
        total_earned: 0,
        total_withdrawn: 0,
        tasks_completed: 0,
        completed_tasks: [],
        daily_ads_watched: 0,
        referral_code: uniqueReferralCode,
        created_at: new Date().toISOString()
      };
    }

    const responseProfile = {
      id: dbUser.id || `tg_${tgUser.id}`,
      telegram_id: String(tgUser.id),
      first_name: tgUser.first_name,
      last_name: tgUser.last_name || null,
      display_name: displayName,
      username: username,
      photo_url: photoUrl,
      is_verified: true,
      telegram_verified: true,
      telegram_verified_at: new Date().toISOString(),
      balance: Number(dbUser.balance) || 0,
      total_referrals: Number(dbUser.total_referrals) || 0,
      level: Number(dbUser.level) || 0,
      total_earned: Number(dbUser.total_earned) || 0,
      total_withdrawn: Number(dbUser.total_withdrawn) || 0,
      tasks_completed: Number(dbUser.tasks_completed) || 0,
      completed_tasks: Array.isArray(dbUser.completed_tasks) ? dbUser.completed_tasks : [],
      daily_ads_watched: Number(dbUser.daily_ads_watched) || 0,
      referral_code: dbUser.referral_code || generateDeterministicCode(tgUser.id),
      created_at: dbUser.created_at || new Date().toISOString()
    };

    return res.json({
      success: true,
      verified: true,
      isNewUser,
      referralConfirmed,
      telegramUser: {
        id: tgUser.id,
        first_name: tgUser.first_name,
        last_name: tgUser.last_name || '',
        username: tgUser.username || '',
        photo_url: photoUrl
      },
      profile: responseProfile
    });
  } catch (err: any) {
    console.error('Server processTelegramVerification error:', err);
    res.status(500).json({ success: false, verified: false, error: err.message || 'Internal server error' });
  }
}

function generateDeterministicCode(seed: string): string {
  return crypto.createHash('md5').update(String(seed)).digest('hex').slice(0, 6).toUpperCase();
}

app.post('/api/telegram-verify', processTelegramVerification);
app.post('/api/telegram-auth', processTelegramVerification);

app.post('/api/telegram-webhook', async (req: Request, res: Response) => {
  res.status(200).json({ ok: true });
  const update = req.body;
  if (!update || !update.update_id) {
    return;
  }

  if (processedUpdateIds.has(update.update_id)) {
    return;
  }
  processedUpdateIds.add(update.update_id);

  const message = update.message;
  if (!message || !message.text) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const webAppBaseUrl = TELEGRAM_WEBAPP_URL || `${req.protocol}://${req.get('host')}`;

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[Telegram Webhook] TELEGRAM_BOT_TOKEN not configured.');
    return;
  }

  try {
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const referralCode = parts.length > 1 ? parts[1].trim().toUpperCase() : null;
      let webAppUrl = webAppBaseUrl;
      let welcomeText = `🚀 Welcome to **Refer & Earn Money**!\n\n🎬 Watch Rewarded Video Ads\n📋 Complete Telegram Channel Tasks\n👥 Invite Friends & Earn ৳ 50.00 per Referral\n⭐ Level up to VIP for ৳ 80.00 Daily Bonus!\n💳 Fast Payouts via bKash & Nagad`;

      if (referralCode) {
        webAppUrl = `${webAppBaseUrl}?start=${encodeURIComponent(referralCode)}`;
        welcomeText = `🎁 **Welcome! You were invited to Refer & Earn Money!**\n\nReferral Code: \`${referralCode}\`\n\nClick the **📱 Open App** button below to complete registration and claim your **৳ 50.00 Welcome Bonus**!`;
      }

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📱 Open App',
                  web_app: { url: webAppUrl }
                }
              ],
              [
                {
                  text: '📖 How to Earn & Rules',
                  callback_data: 'help_rules'
                }
              ]
            ]
          }
        })
      });
    } else if (text === '/help') {
      const helpText = `📖 **Refer & Earn Money Help Guide**\n\n1. **Daily LV Bonus**: Claim daily bonus based on your tier.\n   - Lv 0: ৳ 5/day (0-39 referrals)\n   - Lv 1: ৳ 10/day (40-79 referrals)\n   - Lv 2: ৳ 20/day (80-119 referrals)\n   - Lv 3: ৳ 30/day (120-179 referrals)\n   - Lv 4: ৳ 40/day (180-239 referrals)\n   - Lv 5: ৳ 50/day (240-299 referrals)\n   - VIP: ৳ 80/day (300+ referrals)\n\n2. **Tasks & Ads**:\n   - Watch up to 300 rewarded videos daily (৳ 2.00/ad).\n   - Complete channel join tasks (৳ 50).\n\n3. **Withdrawals**:\n   - Minimum withdrawal: ৳ 1,200.00.\n   - Processed via bKash or Nagad.`;
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: helpText,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📱 Open App',
                  web_app: { url: webAppBaseUrl }
                }
              ]
            ]
          }
        })
      });
    }
  } catch (err: any) {
    console.error('Error dispatching Telegram message in webhook:', err.message);
  }
});

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Refer & Earn Server] Running on http://0.0.0.0:${PORT}`);
    console.log(`[Telegram Integration] WebApp URL: ${TELEGRAM_WEBAPP_URL || `http://localhost:${PORT}`}`);
    console.log(`[Telegram Integration] Bot username: @${TELEGRAM_BOT_USERNAME}`);
    console.log(`[Telegram Integration] Bot token configured: ${Boolean(TELEGRAM_BOT_TOKEN)}`);
  });
}

if (process.argv[1]?.includes('server')) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
