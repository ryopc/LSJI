var worker_default = {
  // 1. 定時実行 (Cron)：8分ごとに修行
  async scheduled(event, env, ctx) {
    const randomPattern = Math.floor(Math.random() * 4);
    // 8分間隔に合わせてURLを叩く
    const fakeRequest = new Request(`https://local/train?pattern=${randomPattern}`);
    await worker_default.fetch(fakeRequest, env);
  },

  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    const jsonHeader = {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: jsonHeader });
    }

    // 1. 設定確認
    const config = await env.DB.prepare("SELECT value FROM settings WHERE key = 'is_active'").first();
    const isActive = config ? config.value === 1 : true;

    if (!isActive && pathname !== "/start" && pathname !== "/status") {
      return new Response(JSON.stringify({ status: "stopped", message: "System is paused." }), { status: 503, headers: jsonHeader });
    }

    // 2. システム操作
    if (pathname === "/stop") {
      await env.DB.prepare("UPDATE settings SET value = 0 WHERE key = 'is_active'").run();
      return new Response(JSON.stringify({ status: "success", message: "System STOPPED" }), { headers: jsonHeader });
    }
    if (pathname === "/start") {
      await env.DB.prepare("UPDATE settings SET value = 1 WHERE key = 'is_active'").run();
      return new Response(JSON.stringify({ status: "success", message: "System STARTED" }), { headers: jsonHeader });
    }

    // 3. 統計・制限確認
    const result = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM battle_history WHERE created_at > date('now')"
    ).first();
    const todayCount = result ? result.count : 0;

    if (pathname === "/status") {
      const stats = await env.DB.prepare(`
        SELECT mode, COUNT(*) as total, 
        ROUND(AVG(CASE WHEN reward > 0 THEN 1 ELSE 0 END) * 100, 1) as win_rate
        FROM battle_history GROUP BY mode
      `).all();
      const brain = await env.DB.prepare("SELECT * FROM q_table ORDER BY state, q_value DESC").all();
      return new Response(JSON.stringify({
        status: isActive ? "running" : "stopped",
        today_total: todayCount,
        limit: 90000,
        performance: stats.results || [],
        ai_brain: brain.results || []
      }, null, 2), { headers: jsonHeader });
    }

    if (todayCount > 90000) {
      return new Response(JSON.stringify({ status: "error", message: "Daily limit reached" }), { status: 503, headers: jsonHeader });
    }

    // 4. 修行モード (/train)
    if (pathname === "/train") {
      const pattern = parseInt(searchParams.get("pattern") || "0");
      // 8分間隔(1日180回)なので、1回200戦だと1日3.6万戦。ちょうど良い負荷です。
      const batchSize = 200; 
      const { results: q_rows } = await env.DB.prepare("SELECT * FROM q_table").all();
      
      let q_map = {};
      (q_rows || []).forEach((row) => {
        q_map[`${row.state}-${row.action}`] = row.q_value;
      });

      let prevStateB = Math.floor(Math.random() * 3);
      const statements = [];

      for (let i = 0; i < batchSize; i++) {
        let bestAction = 0;
        let maxQ = -Infinity;
        for (let a = 0; a < 3; a++) {
          let val = q_map[`${prevStateB}-${a}`] || 0;
          if (val > maxQ) {
            maxQ = val;
            bestAction = a;
          }
        }

        let hand_b;
        switch (pattern) {
          case 1: hand_b = 0; break;
          case 2: hand_b = (prevStateB + 2) % 3; break;
          case 3: hand_b = i % 3; break;
          default: hand_b = Math.floor(Math.random() * 3);
        }

        const judge = (bestAction - hand_b + 3) % 3;
        const reward = judge === 2 ? 1 : judge === 1 ? -1 : 0;

        const q_key = `${prevStateB}-${bestAction}`;
        const oldQ = q_map[q_key] || 0;
        q_map[q_key] = oldQ + 0.1 * (reward - oldQ);

        statements.push(env.DB.prepare("INSERT INTO battle_history (mode, hand_a, hand_b, reward) VALUES ('train', ?, ?, ?)").bind(bestAction, hand_b, reward));
        prevStateB = hand_b;
      }

      // Qテーブルを一括更新
      for (const key in q_map) {
        const [s, a] = key.split("-").map(Number);
        statements.push(env.DB.prepare("UPDATE q_table SET q_value = ? WHERE state = ? AND action = ?").bind(q_map[key], s, a));
      }

      await env.DB.batch(statements);
      return new Response(JSON.stringify({ status: "success", pattern, today_total: todayCount + batchSize }), { headers: jsonHeader });
    }

    // 5. 対戦モード (/play)
    if (pathname === "/play") {
      const userHand = parseInt(searchParams.get("hand") ?? "0");
      const last = await env.DB.prepare("SELECT hand_a FROM battle_history WHERE mode='test' ORDER BY id DESC LIMIT 1").first();
      const state = last ? last.hand_a : 0;

      const row = await env.DB.prepare("SELECT action FROM q_table WHERE state = ? ORDER BY q_value DESC, RANDOM() LIMIT 1").bind(state).first();
      const aiHand = row ? row.action : 0;

      const judge = (aiHand - userHand + 3) % 3;
      const reward = judge === 2 ? 1 : judge === 1 ? -1 : 0;

      await env.DB.batch([
        env.DB.prepare("UPDATE q_table SET q_value = q_value + 0.1 * (? - q_value) WHERE state = ? AND action = ?").bind(reward, state, aiHand),
        env.DB.prepare("INSERT INTO battle_history (mode, hand_a, hand_b, reward) VALUES ('test', ?, ?, ?)").bind(aiHand, userHand, reward)
      ]);

      const hands = ["グー", "チョキ", "パー"];
      return new Response(JSON.stringify({
        status: "success",
        you: hands[userHand],
        ai_hand: hands[aiHand],
        result: reward > 0 ? "AI_WIN" : reward < 0 ? "USER_WIN" : "DRAW"
      }), { headers: jsonHeader });
    }

    return new Response(JSON.stringify({ status: "ready" }), { headers: jsonHeader });
  }
};

export { worker_default as default };
