#!/usr/bin/env node
/**
 * cc-burnout: Detect burnout risk from Claude Code usage patterns
 *
 * cc-score rewards high usage. cc-burnout gives the opposite signal.
 * Sustainable coding > heroic sprints that end in crashes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Config ---
const THRESHOLDS = {
  hoursPerDay: { low: 6, med: 8, high: 10 },     // hours/day
  sessionLength: { low: 90, med: 120, high: 180 }, // minutes
  lateNightHour: 23,                                // 11pm+
  streakDanger: 21,                                 // days without break
  streakCritical: 30,
  weekendRatio: 0.8,                                // 80% of weekends worked
  rampUpThreshold: 1.3,                             // 30% increase week over week
  declineEfficiency: 0.7,                           // 30% drop in commits/hour
};

// --- Parse JSONL (streaming for large files) ---
function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const results = [];
  try {
    const stat = fs.statSync(filePath);
    // For files > 50MB, read in chunks using readline-like approach
    if (stat.size > 50 * 1024 * 1024) {
      const CHUNK = 4 * 1024 * 1024;
      const fd = fs.openSync(filePath, 'r');
      let buf = Buffer.alloc(CHUNK);
      let leftover = '';
      let pos = 0;
      while (pos < stat.size) {
        const read = fs.readSync(fd, buf, 0, CHUNK, pos);
        if (read === 0) break;
        const chunk = leftover + buf.slice(0, read).toString('utf-8');
        const lines = chunk.split('\n');
        leftover = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { results.push(JSON.parse(line)); } catch {}
        }
        pos += read;
      }
      if (leftover.trim()) {
        try { results.push(JSON.parse(leftover)); } catch {}
      }
      fs.closeSync(fd);
    } else {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { results.push(JSON.parse(line)); } catch {}
      }
    }
  } catch {}
  return results;
}

// --- Load sessions ---
function loadSessions(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const sessions = [];
  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(projectsDir, d.name));

  for (const projDir of projectDirs) {
    const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const entries = parseJsonl(path.join(projDir, file));
      const timestamps = entries
        .filter(e => e.type === 'user' || e.type === 'assistant')
        .map(e => e.timestamp)
        .filter(Boolean);
      if (timestamps.length >= 2) {
        const start = Math.min(...timestamps.map(t => new Date(t).getTime()));
        const end = Math.max(...timestamps.map(t => new Date(t).getTime()));
        if (end > start) {
          sessions.push({
            start: new Date(start),
            end: new Date(end),
            durationMin: (end - start) / 60000,
            project: path.basename(projDir),
          });
        }
      }
    }
  }

  return sessions.sort((a, b) => a.start - b.start);
}

// --- Analysis helpers ---
function getDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function getWeekKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

function groupByDay(sessions) {
  const map = {};
  for (const s of sessions) {
    const key = getDayKey(s.start);
    if (!map[key]) map[key] = { sessions: [], totalMin: 0, date: s.start };
    map[key].sessions.push(s);
    map[key].totalMin += s.durationMin;
  }
  return map;
}

function groupByWeek(sessions) {
  const map = {};
  for (const s of sessions) {
    const key = getWeekKey(s.start);
    if (!map[key]) map[key] = { sessions: [], totalMin: 0, weekStart: key };
    map[key].sessions.push(s);
    map[key].totalMin += s.durationMin;
  }
  return map;
}

// --- Risk factors ---
function checkStreaks(dayMap, days) {
  // Count consecutive days with sessions
  let maxStreak = 0;
  let currentStreak = 0;
  let streakStart = null;
  let currentStreakStart = null;
  let breaksCount = 0;

  for (let i = 0; i < days.length; i++) {
    if (dayMap[days[i]]) {
      currentStreak++;
      if (currentStreak === 1) currentStreakStart = days[i];
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
        streakStart = currentStreakStart;
      }
    } else {
      if (currentStreak > 0) breaksCount++;
      currentStreak = 0;
    }
  }

  return { maxStreak, streakStart, breaksCount };
}

function checkLateNights(sessions) {
  const late = sessions.filter(s => {
    const h = s.start.getHours();
    return h >= THRESHOLDS.lateNightHour || h < 4;
  });
  return {
    count: late.length,
    ratio: sessions.length ? late.length / sessions.length : 0,
    recent: late.filter(s => Date.now() - s.start.getTime() < 14 * 86400000).length,
  };
}

function checkWeekendWork(sessions) {
  const weekdays = sessions.filter(s => s.start.getDay() > 0 && s.start.getDay() < 6).length;
  const weekends = sessions.filter(s => s.start.getDay() === 0 || s.start.getDay() === 6).length;
  const total = sessions.length;
  return {
    weekendCount: weekends,
    weekendRatio: total ? weekends / total : 0,
    weekendDays: [...new Set(sessions
      .filter(s => s.start.getDay() === 0 || s.start.getDay() === 6)
      .map(s => getDayKey(s.start)))].length,
  };
}

function checkSessionLengths(sessions) {
  const durations = sessions.map(s => s.durationMin);
  const avg = durations.reduce((a, b) => a + b, 0) / (durations.length || 1);
  const max = Math.max(...durations, 0);
  const longSessions = sessions.filter(s => s.durationMin > THRESHOLDS.sessionLength.high).length;
  const recent = sessions.filter(s => Date.now() - s.start.getTime() < 7 * 86400000);
  const recentAvg = recent.length ? recent.reduce((a, s) => a + s.durationMin, 0) / recent.length : 0;
  return { avg, max, longSessions, recentAvg, recentCount: recent.length };
}

function checkRampUp(weekMap) {
  const weeks = Object.keys(weekMap).sort();
  if (weeks.length < 3) return { trend: 'insufficient_data', ratio: 0 };

  const recent3 = weeks.slice(-3);
  const [w1, w2, w3] = recent3.map(w => weekMap[w].totalMin);

  if (!w1 || !w2) return { trend: 'insufficient_data', ratio: 0 };

  const ratio = w3 / w1; // latest vs 2 weeks ago
  const trend = ratio > THRESHOLDS.rampUpThreshold ? 'escalating' :
                ratio < (1 / THRESHOLDS.rampUpThreshold) ? 'declining' : 'stable';

  return { trend, ratio, w1Hours: (w1/60).toFixed(1), w3Hours: (w3/60).toFixed(1) };
}

// --- Score calculation ---
function calculateBurnoutScore(factors) {
  let score = 0;
  const signals = [];

  // 1. Streak risk (0-25 points)
  const { maxStreak, breaksCount } = factors.streak;
  if (maxStreak >= THRESHOLDS.streakCritical) {
    score += 25;
    signals.push({ icon: '🔴', label: `${maxStreak}日連続稼働`, detail: '30日以上の連続は燃え尽きのサイン', weight: 25 });
  } else if (maxStreak >= THRESHOLDS.streakDanger) {
    score += 15;
    signals.push({ icon: '🟠', label: `${maxStreak}日連続稼働`, detail: '21日以上は要注意', weight: 15 });
  } else if (maxStreak >= 14) {
    score += 8;
    signals.push({ icon: '🟡', label: `${maxStreak}日連続稼働`, detail: '2週間以上継続中', weight: 8 });
  }

  if (breaksCount < 2 && factors.totalDays > 14) {
    score += 10;
    signals.push({ icon: '🟠', label: '休息がほぼない', detail: `${factors.totalDays}日中の休日が${breaksCount}日以下`, weight: 10 });
  }

  // 2. Late nights (0-20 points)
  const { ratio: lateRatio, recent: lateRecent } = factors.lateNights;
  if (lateRatio > 0.3 || lateRecent >= 5) {
    score += 20;
    signals.push({ icon: '🔴', label: `深夜セッション多数 (${Math.round(lateRatio * 100)}%)`, detail: '睡眠の質が下がると判断力も落ちる', weight: 20 });
  } else if (lateRatio > 0.15 || lateRecent >= 2) {
    score += 10;
    signals.push({ icon: '🟡', label: `深夜作業あり (${Math.round(lateRatio * 100)}%)`, detail: '夜型にシフトしている', weight: 10 });
  }

  // 3. Weekend work (0-15 points)
  const { weekendRatio, weekendDays } = factors.weekendWork;
  if (weekendRatio > 0.4 || weekendDays > 8) {
    score += 15;
    signals.push({ icon: '🟠', label: `週末も稼働 (${Math.round(weekendRatio * 100)}%)`, detail: 'オフがない = 回復できない', weight: 15 });
  } else if (weekendRatio > 0.2) {
    score += 7;
    signals.push({ icon: '🟡', label: `週末作業あり (${Math.round(weekendRatio * 100)}%)`, detail: '月2回程度なら許容範囲', weight: 7 });
  }

  // 4. Session length escalation (0-20 points)
  const { avg, longSessions, recentAvg } = factors.sessionLengths;
  if (recentAvg > THRESHOLDS.sessionLength.high) {
    score += 20;
    signals.push({ icon: '🔴', label: `平均セッション${Math.round(recentAvg)}分（直近1週）`, detail: '3時間超えのセッションは集中力の幻想', weight: 20 });
  } else if (recentAvg > THRESHOLDS.sessionLength.med) {
    score += 10;
    signals.push({ icon: '🟡', label: `平均セッション${Math.round(recentAvg)}分（直近1週）`, detail: '2時間超えが続いている', weight: 10 });
  }
  if (longSessions > 3) {
    score += 5;
    signals.push({ icon: '🟡', label: `3時間超えセッション: ${longSessions}回`, detail: '長時間でも質が低下している可能性', weight: 5 });
  }

  // 5. Ramp-up trajectory (0-20 points)
  const { trend, ratio, w1Hours, w3Hours } = factors.rampUp;
  if (trend === 'escalating' && ratio > 1.5) {
    score += 20;
    signals.push({ icon: '🔴', label: `稼働急増 (${w1Hours}h→${w3Hours}h/週)`, detail: '急激な増加は燃え尽きの予兆', weight: 20 });
  } else if (trend === 'escalating') {
    score += 10;
    signals.push({ icon: '🟡', label: `稼働増加傾向 (${w1Hours}h→${w3Hours}h/週)`, detail: '30%以上の週次増加に注意', weight: 10 });
  }

  const cappedScore = Math.min(100, score);
  const level = cappedScore >= 75 ? { label: 'Critical 🔴', en: 'CRITICAL', color: '\x1b[31m' } :
                cappedScore >= 50 ? { label: 'High Risk 🟠', en: 'HIGH', color: '\x1b[33m' } :
                cappedScore >= 25 ? { label: 'Moderate ⚠️', en: 'MODERATE', color: '\x1b[33m' } :
                { label: 'Low ✅', en: 'LOW', color: '\x1b[32m' };

  return { score: cappedScore, level, signals };
}

// --- Recommendations ---
function getRecommendations(score, signals) {
  const recs = [];

  if (score >= 75) {
    recs.push('【緊急】今日は強制休日にしてください。コードを開かない');
    recs.push('翌週から週1日のオフを強制スケジュールに入れる');
  } else if (score >= 50) {
    recs.push('今週中に半日以上の完全休息を入れる');
    recs.push('セッションに2時間の上限を設けてアラームをセット');
  } else if (score >= 25) {
    recs.push('週末の作業は午前中で切り上げる習慣をつける');
    recs.push('深夜作業前に「これは明日でもいいか？」と自問する');
  }

  const hasLateNight = signals.some(s => s.label.includes('深夜'));
  const hasLongSession = signals.some(s => s.label.includes('セッション') && parseInt(s.label.match(/\d+/)?.[0] || '0') > 90);

  if (hasLateNight) recs.push('23時以降のセッション開始を禁止する（ルール化）');
  if (hasLongSession) recs.push('90分ごとに強制10分休憩（ポモドーロ）を試す');

  if (recs.length === 0) recs.push('現状のペースは持続可能。このまま継続');

  return recs;
}

// --- Main ---
function main() {
  const args = process.argv.slice(2);
  const claudeDir = args[0] || path.join(os.homedir(), '.claude');
  const jsonOutput = args.includes('--json');
  const daysArg = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || '30');

  if (!fs.existsSync(claudeDir)) {
    console.error(`Error: ~/.claude directory not found at ${claudeDir}`);
    console.error('Usage: cc-burnout [~/.claude] [--days=30] [--json]');
    process.exit(1);
  }

  const allSessions = loadSessions(claudeDir);

  if (allSessions.length === 0) {
    console.error('No sessions found. Make sure Claude Code has been used.');
    process.exit(1);
  }

  // Filter to analysis window
  const cutoff = new Date(Date.now() - daysArg * 86400000);
  const sessions = allSessions.filter(s => s.start >= cutoff);

  if (sessions.length === 0) {
    console.error(`No sessions found in the last ${daysArg} days.`);
    process.exit(0);
  }

  // Generate all days in range
  const days = [];
  const d = new Date(cutoff);
  while (d <= new Date()) {
    days.push(getDayKey(d));
    d.setDate(d.getDate() + 1);
  }

  const dayMap = groupByDay(sessions);
  const weekMap = groupByWeek(sessions);

  const factors = {
    streak: checkStreaks(dayMap, days),
    lateNights: checkLateNights(sessions),
    weekendWork: checkWeekendWork(sessions),
    sessionLengths: checkSessionLengths(sessions),
    rampUp: checkRampUp(weekMap),
    totalDays: days.length,
    activeDays: Object.keys(dayMap).length,
    totalSessions: sessions.length,
  };

  const { score, level, signals } = calculateBurnoutScore(factors);
  const recommendations = getRecommendations(score, signals);

  if (jsonOutput) {
    console.log(JSON.stringify({
      score,
      level: level.en,
      signals: signals.map(s => ({ label: s.label, detail: s.detail, weight: s.weight })),
      recommendations,
      stats: {
        totalSessions: factors.totalSessions,
        activeDays: factors.activeDays,
        maxStreak: factors.streak.maxStreak,
        lateNightRatio: Math.round(factors.lateNights.ratio * 100),
        weekendRatio: Math.round(factors.weekendWork.weekendRatio * 100),
        avgSessionMin: Math.round(factors.sessionLengths.avg),
      },
      period: `Last ${daysArg} days`,
    }, null, 2));
    return;
  }

  // Pretty output
  const R = '\x1b[0m';
  const B = '\x1b[1m';
  const DIM = '\x1b[2m';

  console.log('');
  console.log(`${B}╔══════════════════════════════════════╗${R}`);
  console.log(`${B}║         cc-burnout 🔥 v1.0.0         ║${R}`);
  console.log(`${B}╚══════════════════════════════════════╝${R}`);
  console.log(`${DIM}  Period: last ${daysArg} days | ${factors.totalSessions} sessions | ${factors.activeDays}/${factors.totalDays} active days${R}`);
  console.log('');

  console.log(`${B}  Burnout Risk Score${R}`);
  console.log(`  ${level.color}${B}${score}/100 — ${level.label}${R}`);
  console.log('');

  if (signals.length > 0) {
    console.log(`${B}  Risk Signals${R}`);
    for (const s of signals) {
      console.log(`  ${s.icon} ${s.label}`);
      console.log(`     ${DIM}${s.detail}${R}`);
    }
    console.log('');
  }

  console.log(`${B}  Key Stats${R}`);
  console.log(`  📅 最長連続稼働: ${factors.streak.maxStreak}日`);
  console.log(`  🌙 深夜セッション: ${Math.round(factors.lateNights.ratio * 100)}% (${factors.lateNights.count}回)`);
  console.log(`  📆 週末稼働率: ${Math.round(factors.weekendWork.weekendRatio * 100)}%`);
  console.log(`  ⏱  平均セッション長: ${Math.round(factors.sessionLengths.avg)}分`);
  console.log('');

  console.log(`${B}  Recommendations${R}`);
  for (const r of recommendations) {
    console.log(`  → ${r}`);
  }
  console.log('');

  if (score <= 24) {
    console.log(`  ${DIM}cc-score is high? Good. But cc-burnout is low — that's the real win.${R}`);
  }
  console.log('');
}

main();
