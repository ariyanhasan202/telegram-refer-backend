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
