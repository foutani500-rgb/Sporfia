/* ============================================================================
 *  server.js — خادم ساحة التوقّع (Tawaqqo Arena)  ·  Vercel + MongoDB
 *  ----------------------------------------------------------------------------
 *  - يعمل كدالة Serverless على Vercel (عبر api/index.js) وأيضاً محلياً: node server.js
 *  - كل الحالة في MongoDB (لا شيء في الذاكرة يُعتمد عليه) — مناسب لبيئة بلا حالة.
 *  - المحاكاة (دقائق/أهداف/أسعار) تُحسب عند الطلب: كل طلب يلحق المباريات بالوقت
 *    المنقضي منذ آخر تحديث بقفل تفاؤلي (version) فلا حاجة لـ Cron ولا SSE.
 *  - محرك المجمّع ومحاكاة المباريات منسوخان داخل هذا الملف من src/pool.js و src/data.js
 *    فيبقى الملف مستقلاً ولا يعتمد على مجلد src عند النشر.
 *
 *  المتغيّرات (Vercel → Settings → Environment Variables):
 *      MONGODB_URI    رابط الاتصال بـ MongoDB (إلزامي)     مثال: mongodb+srv://user:pass@cluster/...
 *      MONGODB_DB     اسم قاعدة البيانات (الافتراضي tawaqqo)
 *      ADMIN_PIN      رمز لوحة الأدمن (الافتراضي 123456 — غيّره!)
 *      ADMIN_SECRET   سرّ توقيع جلسات الأدمن (اختياري، يُشتق تلقائياً إن غاب)
 *      ADMIN_IDS      معرّفات تيليجرام المسموح لها بالأدمن، مفصولة بفواصل
 *      BOT_TOKEN      توكن البوت للتحقق من initData (إن غاب: وضع الضيف مسموح)
 *      ALLOW_GUESTS   ضعها false لمنع الضيوف عند ضبط BOT_TOKEN
 *      SIM_SPEED_MS   سرعة المحاكاة (الافتراضي 1600)
 *      --- الإيداع التلقائي USDT TRC-20 ---
 *      TRC20_ADDRESS     عنوان محفظتك (الافتراضي: العنوان المضبوط أدناه)
 *      TRONGRID_API_KEY  مفتاح TronGrid المجاني (يُنصح به لتفادي حد الطلبات)
 *      MIN_DEPOSIT / MAX_DEPOSIT   الحد الأدنى (لا ينزل عن 10) والأقصى
 *      DEPOSIT_TTL_MIN   مهلة الطلب بالدقائق (الافتراضي 30)
 *      CRON_SECRET       اختياري: لتفعيل /api/cron/deposits (Vercel Cron)
 *      DEPOSIT_ALLOW_GUESTS  لا تضعها إلا للتجربة (الإيداع يتطلب تيليجرام + BOT_TOKEN)
 *
 *      --- وسيط كرة القدم API-Sports (Football Widgets) ---
 *      API_FOOTBALL_KEY            مفتاح API-Sports — يبقى هنا في السيرفر فقط ولا يصل للمتصفح أبداً
 *      FOOTBALL_LEAGUES            الدوريات المسموحة (الافتراضي: كل دوريات وكؤوس العالم — ضع أرقاماً مفصولة بفواصل لحصرها)
 *      FOOTBALL_DAYS_AHEAD         عدد الأيام القادمة المجلوبة (الافتراضي 7)
 *      FOOTBALL_MAX_PER_DAY        أقصى عدد مباريات حقيقية لكل يوم (الافتراضي 100)
 *      FOOTBALL_DAILY_BUDGET       حصة طلبات API-Sports في اليوم (الافتراضي 166)، يتوقف الجلب عند بلوغها ويستأنف في اليوم التالي (UTC)
 *      FOOTBALL_DAILY_REFRESH_MIN  كل كم دقيقة يُحدَّث اليوم والغد (الافتراضي 60) · FOOTBALL_FUTURE_REFRESH_HOURS بقية الأسبوع (6) · FOOTBALL_LIVE_REFRESH_SEC الحية والنتائج (5400 = 90 دقيقة)
 *      FOOTBALL_MIN_PER_DAY        أدنى عدد مباريات لكل يوم (الافتراضي 6) — يُكمَّل بمباريات تجريبية إن نقصت
 *      FOOTBALL_ALLOWED_ORIGINS    اختياري: أصول مسموحة مفصولة بفواصل، مثل https://my-app.netlify.app
 *      FOOTBALL_UPSTREAM_PER_MIN   حد الطلبات الصادرة لـ API-Sports في الدقيقة (الافتراضي 10 = حد الخطة المجانية)
 *      FOOTBALL_IP_PER_MIN         حد الطلبات لكل IP في الدقيقة (الافتراضي 120)
 *
 *
 *  محلياً: ضع المتغيّرات في ملف .env بجانب هذا الملف ثم: node server.js
 * ========================================================================== */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseFixture, liveDist, deadExact, effPools } from "./real-football.js";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ====================== محرك المجمّع (منسوخ من src/pool.js) ====================== */
/* ============ محرك المجمّع (Parimutuel) — منقول من النواة الأصلية ومطوَّر ============
 * الفكرة: السعر يتحرّك حسب أموال المشاركين. عمولة المنصة 5% تُخصم من المجمّع.
 * لاحقاً على الخادم: نفس المعادلات تُنفَّذ على السيرفر وتُبث للواجهة عبر WebSocket.
 */
const FEE = 0; // الافتراضي 0% — الفعلية من إعدادات الأدمن (platformFeePct)
let FEE_NOW = FEE; // النسبة العامة الحالية (تُحدَّث عند تحميل/حفظ الإعدادات)
const clampFeePct = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(50, Math.max(0, n)) : fb; };
/** نسبة المنصة لمباراة: نسبتها الخاصة إن وُضعت (0..50) وإلا النسبة العامة */
const feeOf = (m) => (m && typeof m.feePct === "number" && m.feePct >= 0 && m.feePct <= 50 ? m.feePct / 100 : FEE_NOW);
const HOUSE_SEED = 0.62; // حصة المنصة الأولية من كل مجمّع (سيولة تأسيسية)
const SCORES = [
    ...Array.from({ length: 4 }, (_, h) => Array.from({ length: 4 }, (_, a) => `${h}-${a}`)).flat(),
    "أخرى",
];
const OPT_COUNT = SCORES.length; // 17
const totalPool = (pools) => pools.reduce((a, b) => a + b, 0);
/** احتمالية الخيار i (نسبة من المجمّع) */
const chanceOf = (pools, i) => {
    const t = totalPool(pools);
    return t > 0 ? pools[i] / t : 1 / OPT_COUNT;
};
/** السعر الحالي للخيار i */
const oddsOf = (pools, i, boosted = false, fee = FEE_NOW) => {
    const p = pools[i];
    if (p <= 0)
        return 1.01;
    const base = (totalPool(pools) * (1 - fee)) / p;
    return Math.max(1.01, base); // لا مضاعف: سعر المجمّع فقط (boosted متروك للتوافق ولا أثر له)
};
/** السعر بعد إضافة رهان جديد — ما سيراه المستخدم فعلياً */
const oddsAfter = (pools, i, stake, boosted = false, fee = FEE_NOW) => {
    const pools2 = pools.slice();
    pools2[i] += stake;
    return oddsOf(pools2, i, boosted, fee);
};
/** مكافأة السلسلة: +2% لكل فوز متتالٍ حتى +10% */
const streakBonus = (_streak) => 0; // لا مكافآت إضافية على الربح: الربح = النسبة المعروضة فقط
/** عشوائية مستقرة من بذرة نصية — لضمان ثبات القيمة بين الاستدعاءات المتقاربة */
function seededRand(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
}
/** قيمة الكاش أوت لرهان مفتوح
 * منطق مبسّط واقعي: كلما اقتربت نتيجتك من الفوز (تحسّن سعرها) ارتفعت القيمة، والعكس.
 * seed يجعل القيمة ثابتة خلال نافذة زمنية قصيرة ثم تتغيّر — إحساس "سعر حي" بلا حلقات لا نهائية.
 * على الخادم: تُحسب من معدل التدفّق اللحظي للمجمّع.
 */
function cashoutValue(stake, betOdds, currentOdds, progress, // 0..1 تقدّم المباراة (0 لم تبدأ)
seed = "tq") {
    const drift = currentOdds / Math.max(betOdds, 1.01);
    const edge = 0.88 + seededRand(seed) * 0.06; // هامش المنصة على الكاش أوت
    const raw = stake * Math.max(0.12, Math.min(2.6, drift)) * edge * (0.92 + progress * 0.12);
    return Math.round(Math.max(0.1 * stake, Math.min(raw, stake * betOdds)) * 100) / 100;
}
/** سحب الفائز من المجمّع — محاكاة محلية للنتيجة النهائية
 * على الخادم: تُستبدل بنتيجة المباراة الحقيقية من مزوّد البيانات.
 */
function drawWinner(pools) {
    const t = totalPool(pools);
    let r = Math.random() * t;
    for (let i = 0; i < pools.length; i++) {
        r -= pools[i];
        if (r <= 0)
            return i;
    }
    return 0;
}
/** دفع الرهان الفائز مع مكافأة السلسلة */
const payoutOf = (stake, odds, bonus) => Math.round(stake * odds * (1 + bonus) * 100) / 100;
/** أولوية عرض الشبكة: النتائج الأكثر واقعية في المنتصف */
const hotScoreIndices = () => {
    const order = [];
    for (let i = 0; i < OPT_COUNT - 1; i++) {
        const h = Math.floor(i / 4);
        const a = i % 4;
        if (h <= 2 && a <= 2)
            order.push(i);
    }
    order.push(OPT_COUNT - 1);
    return order;
};
/** تنسيق رقم عام */
const fmtN = (n, d = 2) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: d });

/* ====================== محاكاة المباريات (منسوخة من src/data.js) ====================== */
const DEFAULT_LEAGUES = [
    { id: "spl", name: "دوري روشن", country: "السعودية", flag: "🇸🇦", hue: 152 },
    { id: "ucl", name: "دوري الأبطال", country: "أوروبا", flag: "🏆", hue: 42 },
    { id: "epl", name: "البريميرليغ", country: "إنجلترا", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", hue: 0 },
    { id: "laliga", name: "الليغا", country: "إسبانيا", flag: "🇪🇸", hue: 25 },
    { id: "seriea", name: "سيري آ", country: "إيطاليا", flag: "🇮🇹", hue: 340 },
    { id: "bundes", name: "البوندسليغا", country: "ألمانيا", flag: "🇩🇪", hue: 200 },
    { id: "egy", name: "الدوري المصري", country: "مصر", flag: "🇪🇬", hue: 120 },
    { id: "afc", name: "أبطال آسيا", country: "آسيا", flag: "🌏", hue: 90 },
];
const t = (name, short, c1, c2) => ({ name, short, colors: [c1, c2] });
const LEAGUES = DEFAULT_LEAGUES.map((l) => ({ ...l })); // نسخة حيّة يعدّلها الأدمن
/** أوضاع حقيقية معروفة لإحساس واقعي */
const FIXTURES = [
    { league: "spl", home: t("الهلال", "HIL", "#1a6ef0", "#0b3a8f"), away: t("النصر", "NSR", "#f2c200", "#8a6d00"), inMinutes: -1, bias: 1.15, hot: true, boosted: true },
    { league: "epl", home: t("ليفربول", "LIV", "#c8102e", "#6e0819"), away: t("مانشستر سيتي", "MCI", "#6cabdd", "#2c5e8e"), inMinutes: -1, bias: 1.05, hot: true },
    { league: "ucl", home: t("ريال مدريد", "RMA", "#e6e9f0", "#8a8f9d"), away: t("بايرن ميونخ", "FCB", "#dc052d", "#8a0a20"), inMinutes: 18, bias: 1.12, hot: true, boosted: true },
    { league: "laliga", home: t("برشلونة", "BAR", "#a50044", "#5c0025"), away: t("أتلتيكو مدريد", "ATM", "#cb3524", "#1a3b6e"), inMinutes: 55, bias: 1.08 },
    { league: "spl", home: t("الاتحاد", "ITT", "#f8c300", "#93750a"), away: t("الأهلي", "AHL", "#0e7a4e", "#064a2f"), inMinutes: 95, bias: 1.1, hot: true },
    { league: "epl", home: t("أرسنال", "ARS", "#ef0107", "#7a0203"), away: t("توتنهام", "TOT", "#e8e8e8", "#8b0000"), inMinutes: 130, bias: 1.06 },
    { league: "seriea", home: t("إنتر ميلان", "INT", "#0b2fa0", "#071c66"), away: t("يوفنتوس", "JUV", "#e8e8e8", "#141414"), inMinutes: 160, bias: 1.09 },
    { league: "bundes", home: t("دورتموند", "BVB", "#fde100", "#b3a400"), away: t("ليفركوزن", "B04", "#e32221", "#7c1413"), inMinutes: 205, bias: 1.02 },
    { league: "egy", home: t("الأهلي المصري", "AHY", "#d40000", "#7a0000"), away: t("الزمالك", "ZAM", "#e8e8e8", "#c8c8c8"), inMinutes: 245, bias: 1.14, hot: true },
    { league: "afc", home: t("الأهلي السعودي", "AHS", "#0e7a4e", "#064a2f"), away: t("السد", "SAD", "#8a8a8a", "#4a4a4a"), inMinutes: 300, bias: 1.07 },
    { league: "laliga", home: t("إشبيلية", "SEV", "#d81e05", "#7c1102"), away: t("فالنسيا", "VAL", "#f5a300", "#966500"), inMinutes: 350, bias: 1.05 },
    { league: "epl", home: t("تشيلسي", "CHE", "#0a5ca8", "#02385f"), away: t("نيوكاسل", "NEW", "#241f20", "#4a4144"), inMinutes: 420, bias: 1.08 },
    { league: "ucl", home: t("باريس سان جيرمان", "PSG", "#0a5a8c", "#02314c"), away: t("إنتر ميامي", "MIA", "#f7b5cd", "#e0518f"), inMinutes: 520, bias: 1.22, boosted: true },
    { league: "spl", home: t("القادسية", "QAD", "#e86a17", "#8f4109"), away: t("الفتح", "FTH", "#1a8a5c", "#0d5636"), inMinutes: 610, bias: 1.04 },
    { league: "seriea", home: t("ميلان", "MIL", "#fb090b", "#9b0506"), away: t("نابولي", "NAP", "#12a0d7", "#0a6a92"), inMinutes: 720, bias: 1.06 },
    { league: "bundes", home: t("شتوتغارت", "VFB", "#e32219", "#8f150f"), away: t("فرانكفورت", "SGE", "#1a1a1a", "#c0392b"), inMinutes: 840, bias: 1.03 },
    { league: "afc", home: t("الوكرة", "WAK", "#7a1fa2", "#4a1263"), away: t("بيرانا", "PER", "#e0451f", "#8f2a12"), inMinutes: 980, bias: 1.05 },
    { league: "egy", home: t("بيراميدز", "PYR", "#1a9bd7", "#0d6a94"), away: t("المصري", "MAS", "#0e7a4e", "#064a2f"), inMinutes: 1150, bias: 1.08 },
];
/** وزن واقعي لتوزيع النتائج حسب قوة المستضيف */
function seedPools(bias) {
    const g = [0.3, 0.35, 0.22, 0.1]; // أهداف المستضيف
    const pools = [];
    for (let i = 0; i < OPT_COUNT - 1; i++) {
        const h = Math.floor(i / 4);
        const a = i % 4;
        const base = g[h] * g[a];
        const tilt = h > a ? bias : a > h ? 1 / bias : 1.02;
        pools.push(Math.round(base * tilt * 900 + 6));
    }
    pools.push(24); // خيار "أخرى"
    return pools;
}
function buildMatch(seed, idx) {
    const startsAt = seed.inMinutes < 0 ? Date.now() - 34 * 60000 : Date.now() + seed.inMinutes * 60000;
    const pools = seedPools(seed.bias);
    const live = seed.inMinutes < 0;
    const odds = pools.map((_, i) => oddsOf(pools, i, seed.boosted));
    return {
        id: `m${idx + 1}`,
        leagueId: seed.league,
        home: seed.home,
        away: seed.away,
        startsAt,
        status: live ? "live" : "upcoming",
        minute: live ? 34 : 0,
        score: live ? [1, 0] : [0, 0],
        pools,
        oddsHistory: Array.from({ length: OPT_COUNT }, () => [odds[0] * (0.94 + Math.random() * 0.1), odds[Math.min(OPT_COUNT - 1, 0)]]).map((_, i) => Array.from({ length: 12 }, (_, k) => +(odds[i] * (0.9 + (k / 11) * 0.18 + (Math.random() - 0.5) * 0.06)).toFixed(3))),
        hot: seed.hot,
        boosted: seed.boosted,
    };
}
/** إنشاء قائمة المباريات كاملة */
function buildMatches() {
    return FIXTURES.map(buildMatch);
}
/** تقدّم المباراة 0..1 */
const matchProgress = (m) => m.status === "live" ? Math.min(1, m.minute / 90) : m.status === "ended" ? 1 : Math.max(0, Math.min(1, 1 - (m.startsAt - Date.now()) / (6 * 3600_000)));
/** خيارات الرهان للعرض */
const optionLabel = (i) => SCORES[i];
/** اسم الدوري */
const leagueOf = (id) => LEAGUES.find((l) => l.id === id) ?? LEAGUES[0];
/** شعار فريق مولّد — دائرة متدرجة باختصار الفريق */
const crestStyle = (team) => ({
    background: `linear-gradient(135deg, ${team.colors[0]}, ${team.colors[1]})`,
});
/** أحداث البث الحي — تحديث الدقائق والنتائج والأسعار (محاكاة محلية) */
function tickMatches(matches) {
    const goals = [];
    const next = matches.map((m) => {
        if (m.real || m.status === "ended")
            return m;
        // مباراة لم تبدأ ووصل موعدها → مباشرة
        if (m.status === "upcoming" && Date.now() >= m.startsAt) {
            return { ...m, status: "live", minute: 1, score: [0, 0] };
        }
        if (m.status === "live") {
            let minute = m.minute + 1;
            let score = [...m.score];
            // احتمال هدف — أعلى في المباريات المميزة
            if (Math.random() < 0.02) {
                const homeGoal = Math.random() < 0.54;
                if (homeGoal)
                    score[0] += 1;
                else
                    score[1] += 1;
                goals.push({ matchId: m.id, team: homeGoal ? "home" : "away", minute });
            }
            // نهاية المباراة بعد الدقيقة 90
            if (minute >= 90) {
                return { ...m, status: "ended", minute: 90, score };
            }
            // انحراف المجمّعات — أموال جديدة تدخل السوق
            const pools = m.pools.map((p, i) => {
                const noise = (Math.random() - 0.5) * 0.06 * p;
                const gravity = score[0] > score[1] && Math.floor(i / 4) > i % 4 ? p * 0.012 : score[1] > score[0] && i % 4 > Math.floor(i / 4) ? p * 0.012 : 0;
                return Math.max(2, Math.round(p + noise + gravity));
            });
            // تحديث تاريخ الأسعار للرسم البياني
            const odds = pools.map((_, i) => oddsOf(pools, i, m.boosted, feeOf(m)));
            const oddsHistory = m.oddsHistory.map((hist, i) => [...hist.slice(-19), +odds[i].toFixed(3)]);
            return { ...m, minute, score, pools, oddsHistory };
        }
        return m;
    });
    return { matches: next, goals };
}
/** تحديث خفيف للأسعار للمباريات غير المباشرة (تدفّق أموال) */
function driftUpcoming(matches) {
    return matches.map((m) => {
        if (m.real || m.status !== "upcoming" || Math.random() < 0.7)
            return m;
        const i = Math.floor(Math.random() * OPT_COUNT);
        const pools = m.pools.slice();
        pools[i] = Math.max(3, Math.round(pools[i] * (0.97 + Math.random() * 0.08)));
        const odds = pools.map((_, k) => oddsOf(pools, k, m.boosted, feeOf(m)));
        const oddsHistory = m.oddsHistory.map((hist, k) => (k === i ? [...hist.slice(-19), +odds[k].toFixed(3)] : hist));
        return { ...m, pools, oddsHistory };
    });
}

/* ============================ إعداد البيئة ============================ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// قراءة .env محلياً فقط (على Vercel تأتي المتغيّرات من لوحة الإعدادات)
try {
  const f = path.join(__dirname, ".env");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* تجاهل */ }

const DIST = path.join(__dirname, "dist");
const PUBLIC = path.join(__dirname, "public");
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_PIN = process.env.ADMIN_PIN || "123456";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const BOT_USERNAME = process.env.BOT_USERNAME || "Sporfiabot";
// نسب العمولة على مبلغ كل رهان: المستوى 1 = 10% ، المستوى 2 = 5% ، المستوى 3 = 3% (قابلة للتعديل عبر REF_RATES="0.10,0.05,0.03")
const REF_RATES = (process.env.REF_RATES || "0.10,0.05,0.03").split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0).concat([0, 0, 0]).slice(0, 3);
const REF_JOIN_BONUS = Number(process.env.REF_JOIN_BONUS ?? 0.2); // مكافأة الداعي عن كل صديق مؤهَّل (تُمنح مرة واحدة عند التأهيل فقط)
const START_BALANCE = Number(process.env.START_BALANCE ?? 0); // رصيد البداية للمستخدم الجديد: 0$ (يمكن تغييره بمتغير البيئة START_BALANCE)
const MAX_CATCHUP = 150;                 // أقصى عدد نبضات تُحسب في طلب واحد
const ENDED_KEEP_MS = 15 * 60_000;       // المباراة المنتهية تُستبدل بجديدة بعد 15 دقيقة

const DEFAULT_PAYMENTS = [
  { id: "card", name: "بطاقة بنكية", emoji: "💳", note: "Visa · Mastercard · مدى", minDeposit: 10, maxDeposit: 5000, feePct: 0, eta: "فوري", enabled: true },
  { id: "usdt", name: "USDT", emoji: "🪙", note: "شبكة TRC20 — إيداع كريبتو", minDeposit: 5, maxDeposit: 20000, feePct: 0, eta: "دقيقة واحدة", enabled: true },
  { id: "ton", name: "TON", emoji: "💎", note: "محفظة تيليجرام — الأسرع للـ Mini App", minDeposit: 2, maxDeposit: 10000, feePct: 0, eta: "فوري", enabled: true },
  { id: "stcpay", name: "STC Pay", emoji: "📱", note: "محافظ رقمية خليجية", minDeposit: 10, maxDeposit: 3000, feePct: 1, eta: "فوري", enabled: true },
  { id: "vodafone", name: "فودافون كاش", emoji: "🔴", note: "مصر — محفظة موبايل", minDeposit: 5, maxDeposit: 1500, feePct: 1.5, eta: "دقائق", enabled: true },
  { id: "instapay", name: "InstaPay", emoji: "⚡", note: "تحويل بنكي مصري لحظي", minDeposit: 10, maxDeposit: 5000, feePct: 0, eta: "لحظي", enabled: true },
];
const DEFAULT_VIP_TIERS = [
  { key: "bronze", name: "برونزي", minXp: 0, emoji: "🥉", perk: "كاش أوت أساسي" },
  { key: "silver", name: "فضي", minXp: 100, emoji: "🥈", perk: "+مكافأة إيداع 5%" },
  { key: "gold", name: "ذهبي", minXp: 500, emoji: "🥇", perk: "أسعار معزّزة يومياً" },
  { key: "platinum", name: "بلاتيني", minXp: 1500, emoji: "💠", perk: "سحب أولوية + هدايا" },
  { key: "diamond", name: "ماسي", minXp: 5000, emoji: "💎", perk: "مدير حساب خاص" },
  { key: "legend", name: "أسطوري", minXp: 15000, emoji: "👑", perk: "دعوات VIP + عمولة 0" },
];
const DEFAULT_SETTINGS = {
  maintenance: false, maintenanceMsg: "التطبيق في صيانة قصيرة، نعود قريباً ⚙️",
  bettingEnabled: true, depositsEnabled: true, withdrawalsEnabled: true,
  simPaused: false, simSpeedMs: Number(process.env.SIM_SPEED_MS) || 1600,
  liveBetting: true, cashoutEnabled: true, cancelEnabled: true,
  liveCutoffMin: 85,        // آخر دقيقة يُسمح فيها بالرهان الحي (90 = حتى النهاية)
  goalPauseSec: 30,         // إيقاف الرهان لحظات بعد كل هدف (حماية من تأخر البيانات)
  realMatchesEnabled: true, // جلب المباريات الحقيقية من API-Sports
  realSyncSec: 10,          // كل كم ثانية نحدّث المباريات النشطة (يستهلك من حصة API) — الافتراضي 10 ث
  /* ===== محرّك النسب الحية (٪) — يتحكم بنسب كل المباريات الحية حسب سير المباراة ===== */
  liveRatesEnabled: true,   // تسعير النسب تلقائياً حسب سير المباراة (إيقافه = النسبة من أموال اللاعبين)
  liveRateMin: 0.1,         // أدنى نسبة ربح ٪ (للنتيجة المضمونة)
  liveRateMax: 20,          // أعلى نسبة ربح ٪ (للنتيجة المستحيلة/شبه المستحيلة) — رهان 100$ بنسبة 20 يدفع 120$
  liveRateSpeed: 1,         // حساسية الدقيقة: أعلى = تتغير النسب أسرع مع مرور الوقت (0.5 – 3)
  liveRateGoalAvg: 2.7,     // معدل أهداف المباراة الكاملة المتوقّع (يؤثر على سرعة تغيّر النسب بعد الأهداف)
  liveRateNoisePct: 3,      // حركة عشوائية خفيفة كل 10 ثوانٍ (0 = بلا حركة)
  showSimMatches: true,     // إظهار مباريات الساحة التجريبية بجانب الحقيقية
  minStake: 1, maxStake: 0, cashoutMarginPct: 0,
  platformFeePct: 0, // نسبة ربح المنصة المخصومة من مجمّع كل مباراة (0..50) — الافتراضي 0%، وتُعدَّل من لوحة الأدمن
  dailyBonusEnabled: true, commissionEnabled: true, autoDepositEnabled: true,
  bonusBase: 2, bonusPerStreak: 0.5, bonusCooldownHours: 24,
  celebrations: true, withdrawAutoApprove: true, minWithdraw: 5, maxWithdraw: 0,
  minDeposit: Math.max(0, Number(process.env.MIN_DEPOSIT) || 10), maxDeposit: Number(process.env.MAX_DEPOSIT) || 5000, // حدود الإيداع (تُعدَّل من لوحة الأدمن)
  announcement: { enabled: false, text: "", tone: "info" },
  supportEnabled: true, supportUrl: "https://t.me/abdoblilach",
  supportTipTitle: "الدعم الفني", supportTipText: "نحن متصلون · كلّمنا على تلجرام",
  bonusSectionTitle: "مكافآت اليوم", bonusTitle: "المكافأة اليومية",
  noticeEnabled: true, noticeShowLive: true, noticeText: "",
};

/* ----------------------------- أدوات صغيرة ----------------------------- */
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const r2 = (n) => Math.round(n * 100) / 100;
const todayKey = () => new Date().toISOString().slice(0, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbid = (m) => new HttpError(403, m);
const notFound = (m = "غير موجود") => new HttpError(404, m);
/** يحوّل وثيقة Mongo إلى الشكل الذي تتوقّعه الواجهة (_id → id) */
const pub = (d, keepUser = false) => {
  if (!d) return d;
  const { _id, userId, ...rest } = d;
  return keepUser ? { id: _id, userId, ...rest } : { id: _id, ...rest };
};

/* ============================ MongoDB ============================ */
let dbPromise = null;
async function getDb() {
  if (globalThis.__TQ_TEST_DB__) return globalThis.__TQ_TEST_DB__;          // خطّاف للاختبار فقط
  if (!dbPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new HttpError(500, "MONGODB_URI غير مضبوط في متغيّرات البيئة");
    dbPromise = (async () => {
      const { MongoClient } = await import("mongodb");
      const client = await new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 }).connect();
      const db = client.db(process.env.MONGODB_DB || "tawaqqo");
      // فهارس (مرة واحدة لكل instance، وتتجاهل الفشل)
      await Promise.allSettled([
        db.collection("bets").createIndex({ userId: 1, createdAt: -1 }),
        db.collection("bets").createIndex({ status: 1, matchId: 1 }),
        db.collection("txs").createIndex({ userId: 1, at: -1 }),
        db.collection("refs").createIndex({ inviterId: 1 }),
        db.collection("refs").createIndex({ userId: 1 }, { unique: true }),
        db.collection("users").createIndex({ balance: -1 }),
        db.collection("users").createIndex({ lastSeenAt: -1 }),
        db.collection("bets").createIndex({ createdAt: -1 }),
        db.collection("txs").createIndex({ kind: 1, status: 1, at: -1 }),
        // الإيداع: مبلغ فريد لكل طلب معلّق، وTXID لا يُعتمد إلا مرة واحدة (حماية من التكرار)
        db.collection("deposits").createIndex({ userId: 1, createdAt: -1 }),
        db.collection("deposits").createIndex({ units: 1 }, { unique: true, partialFilterExpression: { status: "pending" } }),
        db.collection("deposits").createIndex({ txid: 1 }, { unique: true, sparse: true }),
      ]);
      return db;
    })();
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
async function C() {
  const d = await getDb();
  return {
    users: d.collection("users"), bets: d.collection("bets"), txs: d.collection("txs"),
    refs: d.collection("refs"), meta: d.collection("meta"), state: d.collection("state"),
    deposits: d.collection("deposits"),
  };
}
/** findOneAndUpdate يعيد الوثيقة بعد التعديل (يدعم إصدارات المشغّل القديمة والجديدة) */
async function fau(coll, filter, update) {
  const r = await coll.findOneAndUpdate(filter, update, { returnDocument: "after" });
  return r && Object.prototype.hasOwnProperty.call(r, "value") && !("_id" in r) ? r.value : r;
}

/* ---- الإعدادات والكتالوجات (كاش 5 ثوانٍ لكل instance) ---- */
let cfgCache = { at: 0, doc: null };
async function getConfig(force = false) {
  if (!force && cfgCache.doc && Date.now() - cfgCache.at < 5000) return cfgCache.doc;
  const { meta } = await C();
  let doc = await meta.findOne({ _id: "config" });
  if (!doc) {
    doc = { _id: "config", settings: clone(DEFAULT_SETTINGS), leagues: clone(DEFAULT_LEAGUES), vipTiers: clone(DEFAULT_VIP_TIERS), payments: clone(DEFAULT_PAYMENTS) };
    try { await meta.insertOne(doc); } catch { doc = await meta.findOne({ _id: "config" }); }
  }
  if (!doc.settings?.liveMigrated) {   // ترحيل لمرة واحدة: تفعيل الرهان الحي افتراضياً
    await meta.updateOne({ _id: "config" }, { $set: { "settings.liveBetting": true, "settings.liveMigrated": true } });
    doc.settings = { ...(doc.settings || {}), liveBetting: true, liveMigrated: true };
  }
  if (!doc.settings?.sync10Migrated) {   // ترحيل لمرة واحدة: التحديث كل 10 ثوانٍ بدل 15/60
    await meta.updateOne({ _id: "config" }, { $set: { "settings.realSyncSec": 10, "settings.sync10Migrated": true } });
    doc.settings = { ...(doc.settings || {}), realSyncSec: 10, sync10Migrated: true };
  }
  doc.settings = { ...DEFAULT_SETTINGS, ...(doc.settings || {}), announcement: { ...DEFAULT_SETTINGS.announcement, ...(doc.settings?.announcement || {}) } };
  FEE_NOW = clampFeePct(doc.settings.platformFeePct, FEE * 100) / 100;
  LIVE_NOW = doc.settings;
  cfgCache = { at: Date.now(), doc };
  return doc;
}
async function saveConfig(patch) {
  const { meta } = await C();
  await meta.updateOne({ _id: "config" }, { $set: patch });
  cfgCache.at = 0;
}
async function adminLog(msg) {
  const { meta } = await C();
  await meta.updateOne({ _id: "adminlog" }, { $push: { items: { $each: [{ id: uid(), msg, at: Date.now() }], $position: 0, $slice: 200 } } }, { upsert: true });
}

/* ============================ المستخدمون ============================ */
const newUser = (id, name = "لاعبنا", avatar = "🎯") => ({
  _id: id, name, avatar, joinedAt: Date.now(),
  balance: START_BALANCE, vipXp: 0, streak: 0, bestStreak: 0, frozen: false,
  notices: [{ id: uid(), title: "أهلاً بك في ساحة التوقّع 🎉", body: START_BALANCE > 0 ? `حسابك جاهز برصيد $${START_BALANCE}. توقّع النتيجة الدقيقة!` : "حسابك جاهز. اشحن رصيدك وتوقّع النتيجة الدقيقة!", at: Date.now(), read: false, tone: "gold" }],
  autoDeposit: { enabled: false, threshold: 20, amount: 50, method: "ton", dailyCap: 200, depositedToday: 0, capDate: todayKey() },
  limits: { dailyLossLimit: 0, maxStake: 0, selfExcludedUntil: null },
  claimedCommission: 0, referredBy: null, lastBonusAt: 0,
});
// كود الدعوة = معرف حساب تيليجرام نفسه (رقم)، فيُربط الداعي مباشرة بلا بحث ولا حدّ 5000 مستخدم
const inviteCodeOf = (id) => String(Number(id));
// يستخرج معرف الداعي من الكود: يقبل المعرف الرقمي الجديد، ويفكّ الأكواد القديمة (TQxxxx) كي لا تبطل الروابط المنشورة سابقاً
function inviterIdFromCode(raw) {
  const code = String(raw || "").trim().replace(/^ref_/i, "");
  if (/^\d{4,15}$/.test(code)) return Number(code);
  const m = code.match(/^TQ([0-9A-Z]+)$/i);
  if (m) {
    const n = (parseInt(m[1], 36) - 90001) / 7;
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}
function vipOf(xp, cfg) {
  const tiers = cfg.vipTiers;
  let idx = 0;
  tiers.forEach((t, i) => { if (xp >= t.minXp) idx = i; });
  const cur = tiers[idx], next = tiers[idx + 1];
  return { level: idx + 1, tier: cur, next: next || null, progress: next ? Math.min(1, (xp - cur.minXp) / (next.minXp - cur.minXp)) : 1 };
}
const publicUser = (u, cfg) => ({
  id: u._id, name: u.name, avatar: u.avatar, joinedAt: u.joinedAt,
  balance: r2(u.balance), vipXp: u.vipXp, vip: vipOf(u.vipXp, cfg),
  streak: u.streak, bestStreak: u.bestStreak, frozen: u.frozen, banned: !!u.banned,
  inviteCode: inviteCodeOf(u._id), lastBonusAt: u.lastBonusAt, lastSeenAt: u.lastSeenAt || 0,
});
async function addTx(userId, tx) {
  const { txs } = await C();
  const doc = { _id: uid(), userId, at: Date.now(), status: "done", ...tx };
  await txs.insertOne(doc);
  return doc;
}
async function addNotice(userId, n) {
  const { users } = await C();
  await users.updateOne({ _id: userId }, { $push: { notices: { $each: [{ id: uid(), at: Date.now(), read: false, ...n }], $position: 0, $slice: 60 } } });
}

/* ---- التحقق من تيليجرام ---- */
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  if (BOT_TOKEN) {
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() / 1000 - Number(params.get("auth_date") || 0) > 24 * 3600) return null;
  }
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}
async function authUser(req) {
  const initData = req.headers["x-telegram-init-data"];
  const tg = initData ? verifyInitData(String(initData)) : null;
  if (initData && !tg) throw new HttpError(401, "توقيع تيليجرام غير صالح");
  let id, name;
  if (tg) { id = tg.id; name = tg.first_name || "لاعبنا"; }
  else {
    if (BOT_TOKEN && process.env.ALLOW_GUESTS === "false") throw new HttpError(401, "يلزم الدخول عبر تيليجرام");
    id = Number(String(req.headers["x-user-id"] || "0").replace(/[^\d]/g, "")) || 0;   // 0 = ضيف مشترك
  }
  const { users } = await C();
  let u = await users.findOne({ _id: id });
  if (!u) {
    u = newUser(id, name);
    try { await users.insertOne(u); } catch { u = await users.findOne({ _id: id }); }
  } else if (tg && u.name !== name) {
    await users.updateOne({ _id: id }, { $set: { name } });
    u.name = name;
  }
  if (u.banned) throw forbid("تم حظر حسابك من التطبيق");
  return u;
}
function assertActive(u, cfg) {
  if (cfg.settings.maintenance) throw new HttpError(503, cfg.settings.maintenanceMsg);
  if (u.frozen) throw forbid("الحساب مجمّد مؤقتاً");
}

/* ============================ حالة المباريات (بلا حالة + قفل تفاؤلي) ============================ */
async function loadState() {
  const { state } = await C();
  let st = await state.findOne({ _id: "matches" });
  if (!st) {
    st = { _id: "matches", version: 1, lastTickAt: Date.now(), matches: buildMatches() };
    try { await state.insertOne(st); } catch { st = await state.findOne({ _id: "matches" }); }
  }
  return st;
}
/** تعديل المباريات بشكل ذرّي: fn(matches) تُعيد المصفوفة الجديدة (قد تُعاد عند التعارض فلا آثار جانبية داخلها) */
async function mutateState(fn) {
  const { state } = await C();
  for (let i = 0; i < 8; i++) {
    const st = await loadState();
    const next = fn(st.matches);
    const r = await state.updateOne({ _id: "matches", version: st.version }, { $set: { matches: next, version: st.version + 1 } });
    if (r.modifiedCount === 1) return next;
  }
  throw new HttpError(503, "ضغط عالٍ، حاول مجدداً بعد لحظة");
}
function replenish(ms, now) {
  const keep = ms.filter((m) => !(m.status === "ended" && m.endedAt && now - m.endedAt > ENDED_KEEP_MS));
  const removed = ms.filter((m) => !m.real && m.status === "ended" && m.endedAt && now - m.endedAt > ENDED_KEEP_MS).length;
  for (let i = 0; i < removed; i++) {
    const seed = FIXTURES[Math.floor(Math.random() * FIXTURES.length)];
    const nm = buildMatch({ ...seed, inMinutes: 20 + Math.floor(Math.random() * 900) }, 0);
    nm.id = `m${now.toString(36)}${i}`;
    keep.push(nm);
  }
  return keep;
}
/* ===== المباريات الحقيقية من API-Sports: تُدمج في نفس قائمة الساحة وتُسوّى رهاناتها بنتيجة الـ90 دقيقة ===== */
function newRealMatch(p) {
  const pools = seedPools(1.0);
  const odds = pools.map((_, i) => oddsOf(pools, i, false));
  return { ...p, pools, boosted: false, hot: false, oddsHistory: odds.map((o) => [+o.toFixed(3), +o.toFixed(3)]) };
}
async function syncReal(cfg, force = false) {
  const s = cfg.settings;
  if (s.realMatchesEnabled === false || !fbKey() || (s.simPaused && !force)) return { skipped: true };
  const { state } = await C();
  const now = Date.now();
  const gap = force ? 0 : Math.max(30, Number(s.realSyncSec) || 30) * 1000;
  const claim = await state.updateOne({ _id: "matches", $or: [{ realAt: { $lt: now - gap } }, { realAt: { $exists: false } }] }, { $set: { realAt: now } });
  if (claim.modifiedCount !== 1) return { skipped: true };
  const st = await loadState();
  const items = [];
  const grab = async (qs, share = 1) => {
    if (!fbTakeUpstreamToken() || !(await fbTakeDaily(share))) return false;
    const { status, json } = await fbUpstream("fixtures", qs);
    if (status === 200 && !fbHasErrors(json) && Array.isArray(json.response)) { items.push(...json.response); return true; }
    return false;
  };
  const dayStr = (k) => utcDay(now + k * 86_400_000);
  if (force || !st.realDailyAt || now - st.realDailyAt > FB_DAILY_REFRESH_MS) {      // اليوم والغد: كل ساعة (افتراضياً)
    let ok = true;
    for (const k of [0, 1]) ok = (await grab("date=" + dayStr(k) + "&timezone=UTC")) && ok;
    if (ok) await state.updateOne({ _id: "matches" }, { $set: { realDailyAt: now } });
  }
  if (FB_DAYS_AHEAD > 2 && (force || !st.realFutureAt || now - st.realFutureAt > FB_FUTURE_REFRESH_MS)) {   // بقية الأسبوع: كل 6 ساعات (افتراضياً)
    let ok = true;
    for (let k = 2; k < FB_DAYS_AHEAD; k++) ok = (await grab("date=" + dayStr(k) + "&timezone=UTC")) && ok;
    if (ok) await state.updateOne({ _id: "matches" }, { $set: { realFutureAt: now } });
  }
  const active = st.matches.filter((m) => m.real && m.status !== "ended" && m.startsAt <= now + 10 * 60_000).slice(0, 20).map((m) => m.fid);
  if (active.length && (force || !st.realLiveAt || now - st.realLiveAt > FB_LIVE_REFRESH_MS)) {    // تحديث النشطة (دقيقة/نتيجة/نهاية): كل 90 دقيقة (افتراضياً)
    const needFinal = st.matches.some((m) => m.real && m.status !== "ended" && m.startsAt < now - 100 * 60_000);   // مباراة يُفترض أنها انتهت: نتيجتها لازمة للتسوية فلها أولوية كاملة
    if (await grab("ids=" + active.join("-") + "&timezone=UTC", needFinal ? 1 : 0.85)) await state.updateOne({ _id: "matches" }, { $set: { realLiveAt: now } });
  }
  const seen = new Set();
  let parsed = items.map(parseFixture).filter((p) => p && fbLeagueOk(p.leagueApiId) && !seen.has(p.id) && seen.add(p.id));
  /* حد أقصى لكل يوم (FOOTBALL_MAX_PER_DAY): الأهم أولاً — لا يمسّ المباريات الموجودة أصلاً (حتى لا تضيع رهانات) */
  const have = new Map(st.matches.filter((m) => m.real).map((m) => [m.id, m]));
  const perDay = new Map();
  for (const m of have.values()) { const d = utcDay(m.startsAt); perDay.set(d, (perDay.get(d) || 0) + 1); }
  const fresh = parsed.filter((p) => !have.has(p.id) && p.status !== "ended" && p.status !== "void").sort((a, b) => fbPrio(a.leagueApiId) - fbPrio(b.leagueApiId) || a.startsAt - b.startsAt);
  const drop = new Set();
  for (const p of fresh) { const d = utcDay(p.startsAt); const n = perDay.get(d) || 0; if (n >= FB_MAX_PER_DAY) drop.add(p.id); else perDay.set(d, n + 1); }
  parsed = parsed.filter((p) => !drop.has(p.id));
  if (!parsed.length) return { fetched: 0 };
  const ended = new Set(), voided = new Set();
  const ms = await mutateState((arr) => {
    ended.clear(); voided.clear();
    const out = arr.slice(), idx = new Map(arr.map((m, i) => [m.id, i]));
    for (const p of parsed) {
      const i = idx.get(p.id);
      if (i === undefined) {
        if (p.status === "ended" || p.status === "void" || p.status === "live") continue;
        out.push(newRealMatch(p)); idx.set(p.id, out.length - 1); continue;
      }
      const m = out[i];
      if (!m.real || m.status === "ended") continue;
      if (p.status === "void" || p.status === "live") { voided.add(m.id); continue; }
      const next = { ...m, apiStatus: p.apiStatus, status: p.status, minute: p.minute, startsAt: p.startsAt, round: p.round,
        home: { ...m.home, logo: p.home.logo }, away: { ...m.away, logo: p.away.logo } };
      if (p.status === "live" || p.status === "ended") {
        if (p.status === "live" && p.score[0] + p.score[1] > m.score[0] + m.score[1])
          next.suspendUntil = Date.now() + Math.max(0, Number(s.goalPauseSec ?? 30)) * 1000;
        next.score = p.score;
      }
      if (p.status === "ended") { next.endedAt = Date.now(); next.minute = 90; ended.add(m.id); }
      out[i] = next;
    }
    return out.filter((m) => !voided.has(m.id));
  });
  if (ended.size) await settleBets(ended, ms).catch((e) => console.error("settle real:", e));
  if (voided.size) {
    const { bets } = await C();
    for (const id of voided) for (const b of await bets.find({ status: "open", matchId: id }).toArray()) await refundBet(b, "إلغاء المباراة").catch(() => undefined);
  }
  return { fetched: parsed.length, ended: ended.size, voided: voided.size };
}
/** يضمن ألا ينزل أي يوم من الأسبوع القادم عن FOOTBALL_MIN_PER_DAY مباريات: يكمّله بمباريات تجريبية من قائمة الساحة */
async function ensureDailyMin() {
  return;   // ⛔ معطّل: لا مباريات تجريبية
  // eslint-disable-next-line no-unreachable
  const { state: stLock } = await C();
  const nowLock = Date.now();
  const lk = await stLock.updateOne(
    { _id: "matches", $or: [{ ensureAt: { $lt: nowLock - 600_000 } }, { ensureAt: { $exists: false } }] },
    { $set: { ensureAt: nowLock } });
  if (lk.modifiedCount !== 1) return;   // نسخة أخرى فحصت قبل أقل من 10 دقائق
  const st = await loadState();
  const cfg0 = await getConfig();
  /* لا تُكمِّل قبل أن يُجرَّب جلب المباريات الحقيقية (نجح أو فشل). إن كان الجلب معطّلاً/بلا مفتاح/فاشلاً (حد يومي منتهٍ) تُكمَّل مباشرة حتى لا تبقى القائمة فارغة */
  const realOn = cfg0.settings.realMatchesEnabled !== false && !!fbKey();
  if (realOn && !st.realAt) return;
  const now = Date.now();
  const counts = new Map();
  for (const m of st.matches) { const d = utcDay(m.startsAt); counts.set(d, (counts.get(d) || 0) + 1); }
  const pool = FIXTURES.filter((f) => f.inMinutes >= 0);
  const adds = [];
  for (let k = 0; k < FB_DAYS_AHEAD; k++) {
    const day = utcDay(now + k * 86_400_000), need = FB_MIN_PER_DAY - (counts.get(day) || 0);
    if (need <= 0) continue;
    const dayStart = Date.parse(day + "T00:00:00Z"), from = Math.max(now + 90 * 60_000, dayStart + 10 * 3600_000), to = dayStart + 23.5 * 3600_000;
    if (to <= from) continue;
    for (let i = 0; i < need; i++) {
      const seed = pool[(k * 7 + i) % pool.length];
      const nm = buildMatch({ ...seed, inMinutes: Math.round((from + ((to - from) * (i + 0.5)) / need - now) / 60_000) }, 0);
      nm.id = `s${day.replace(/-/g, "")}${i}`;
      adds.push(nm);
    }
  }
  if (!adds.length) return;
  await mutateState((arr) => { const ids = new Set(arr.map((m) => m.id)); return [...arr, ...adds.filter((m) => !ids.has(m.id))]; });
}
/** يلحق المباريات بالوقت الحقيقي ويسوّي الرهانات للمباريات المنتهية */
/** إزالة المباريات الحية (والتجريبية التي كانت ستصير حية) مع استرداد رهاناتها المفتوحة — تعمل فقط عند وجود ما يُزال */
async function purgeLive() {
  const st = await loadState();
  const now = Date.now();
  const drop = (m) => m.status === "live" || (!m.real && m.status === "upcoming" && m.startsAt <= now) || (m.status === "ended" && m.endedAt && now - m.endedAt > ENDED_KEEP_MS);
  const gone = st.matches.filter(drop);
  if (!gone.length) return st.matches;
  const ids = gone.map((m) => m.id);
  const { bets } = await C();
  for (const b of await bets.find({ status: "open", matchId: { $in: ids } }).toArray()) await refundBet(b, "إزالة المباراة الحية").catch(() => undefined);
  return mutateState((arr) => arr.filter((m) => !drop(m)));
}
async function syncMatches() {
  const cfg = await getConfig();
  await syncReal(cfg).catch((e) => console.error("syncReal:", e?.message || e));
  await ensureDailyMin().catch((e) => console.error("ensureDailyMin:", e?.message || e));
  return await purgeLive();   // ⛔ المحاكاة والمباريات الحية معطّلة: لا نبضات ولا كتابات متكررة
  // eslint-disable-next-line no-unreachable
  const speed = Math.max(500, cfg.settings.simSpeedMs || 1600);
  const { state } = await C();
  for (let attempt = 0; attempt < 1; attempt++) {
    const st = await loadState();
    const now = Date.now();
    if (cfg.settings.simPaused) {
      if (now - st.lastTickAt > speed) await state.updateOne({ _id: "matches", version: st.version }, { $set: { lastTickAt: now } });
      return st.matches;
    }
    const ticks = Math.floor((now - st.lastTickAt) / speed);
    const stale = st.matches.some((m) => m.status === "ended" && m.endedAt && now - m.endedAt > ENDED_KEEP_MS);
    if (ticks < 1 && !stale) return st.matches;
    const n = Math.min(ticks, MAX_CATCHUP);
    let ms = st.matches;
    const ended = new Set();
    for (let i = 0; i < n; i++) {
      const frozen = new Set(ms.filter((m) => m.frozen).map((m) => m.id));
      const t0 = tickMatches(ms);
      let nx = t0.matches.map((m, k) => (frozen.has(m.id) ? ms[k] : m));
      nx = driftUpcoming(nx);
      nx = nx.map((m, k) => {
        if (m.status === "ended" && ms[k].status !== "ended") { ended.add(m.id); return { ...m, endedAt: now }; }
        return m;
      });
      ms = nx;
    }
    ms = replenish(ms, now);
    const newLast = ticks >= MAX_CATCHUP ? now : st.lastTickAt + n * speed;
    const r = await state.updateOne({ _id: "matches", version: st.version }, { $set: { matches: ms, lastTickAt: newLast, version: st.version + 1 } });
    if (r.modifiedCount === 1) {
      if (ended.size) await settleBets(ended, ms).catch((e) => console.error("settle:", e));
      return ms;
    }
  }
  return (await loadState()).matches;
}
/* ===== سوق «نتيجة المباراة» (فوز المستضيف / تعادل / فوز الضيف): مجمّع مستقل من 3 خيارات =====
 * قبل أول رهان عليه يُشتق من مجمّع النتائج الدقيقة (مجموع خلايا فوز/تعادل/فوز + 1/3 لـ«أخرى») ثم يُخزَّن ويتحرك بأموال اللاعبين. */
const RES_PICKS = ["1", "X", "2"];
const rPoolsOf = (m) => {
  if (Array.isArray(m.rPools) && m.rPools.length === 3) return m.rPools;
  const r = [0, 0, 0];
  for (let h = 0; h < 4; h++) for (let a = 0; a < 4; a++) r[h > a ? 0 : h === a ? 1 : 2] += m.pools[h * 4 + a] || 0;
  const other = (m.pools[OPT_COUNT - 1] || 0) / 3;
  return r.map((v) => Math.max(1, +(v + other).toFixed(2)));
};
const resultIdx = (score) => (score[0] > score[1] ? 0 : score[0] === score[1] ? 1 : 2);
const poolsForBet = (m, b) => (b.market === "result" ? rPoolsOf(m) : m.pools);
const pickText = (b, m) => (b.market === "result" ? [`فوز ${m.home.name}`, "تعادل", `فوز ${m.away.name}`][RES_PICKS.indexOf(b.pick)] || b.pick : b.pick);
const matchViewBase = (m) => ({
  ...m,
  rPools: rPoolsOf(m),
  rOdds: rPoolsOf(m).map((_, i) => +oddsOf(rPoolsOf(m), i, m.boosted, feeOf(m)).toFixed(3)),
  rChances: rPoolsOf(m).map((_, i) => +chanceOf(rPoolsOf(m), i).toFixed(4)),
  odds: m.pools.map((_, i) => +oddsOf(m.pools, i, m.boosted, feeOf(m)).toFixed(3)),
  chances: m.pools.map((_, i) => +chanceOf(m.pools, i).toFixed(4)),
  totalPool: Math.round(totalPool(m.pools)),
  options: SCORES,
  effFeePct: +(feeOf(m) * 100).toFixed(2), // النسبة المطبّقة فعلياً على هذه المباراة (الخاصة أو العامة)
  progress: +matchProgress(m).toFixed(3),
});
/* ====================== نظام النسب (٪) — الربح بالنسبة المئوية فقط ======================
 * النسبة المعروضة لكل نتيجة = صافي الربح من مبلغ الرهان، بين liveRateMin (0.1%) و liveRateMax (20%).
 * رهان 100$ بنسبة 20% → يُدفع 120$ (ربح 20$). لا مضاعفات ولا مكافآت إضافية.
 * النتيجة المستحيلة/شبه المستحيلة = الحد الأعلى، والمضمونة = الحد الأدنى، وتتحرك مع النتيجة والدقيقة.
 * الضبط اليدوي من الأدمن (manualRates) يثبّت نسب سوق معيّن حتى "العودة للتلقائي". */
let LIVE_NOW = DEFAULT_SETTINGS;
const clampN = (v, lo, hi, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; };
const poissonPmf = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
const rateBounds = () => {
  const lo = clampN(LIVE_NOW.liveRateMin, 0, 50, 0.1);
  return { lo, hi: Math.max(lo, clampN(LIVE_NOW.liveRateMax, 0.1, 100, 20)) };
};
/** النتائج الدقيقة المستحيلة الآن (أقل من النتيجة الحالية) */
const deadOf = (m) => {
  if (m.real) return deadExact(m.score);
  return SCORES.map((_, i) => i < OPT_COUNT - 1 && (Math.floor(i / 4) < m.score[0] || (i % 4) < m.score[1]));
};
/** احتمالات النتيجة النهائية: دقيقة (17) ونتيجة المباراة (3) — من النتيجة الحالية والدقيقة */
function matchProbs(m) {
  if (LIVE_NOW.liveRatesEnabled === false) {   // التلقائي متوقف: الاحتمال = حصة الخيار من أموال اللاعبين
    const rp = rPoolsOf(m);
    return { exact: m.pools.map((_, i) => chanceOf(m.pools, i)), res: rp.map((_, i) => chanceOf(rp, i)) };
  }
  const S = LIVE_NOW, live = m.status === "live";
  const speed = clampN(S.liveRateSpeed, 0.3, 4, 1), avg = clampN(S.liveRateGoalAvg, 0.5, 8, 2.7);
  const left = Math.pow(Math.max(0, 90 - (live ? Math.min(90, m.minute || 0) : 0)) / 90, speed);
  const lh = avg * 0.54 * left, la = avg * 0.46 * left;
  const [s0, s1] = live ? (m.score || [0, 0]) : [0, 0];
  const bucket = Math.floor(Date.now() / 10_000), noise = clampN(S.liveRateNoisePct, 0, 20, 3) / 100;
  const exact = new Array(OPT_COUNT).fill(0), res = [0, 0, 0];
  for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) {
    const h = s0 + i, a = s1 + j, pr = poissonPmf(i, lh) * poissonPmf(j, la);
    exact[h <= 3 && a <= 3 ? h * 4 + a : OPT_COUNT - 1] += pr;
    res[h > a ? 0 : h === a ? 1 : 2] += pr;
  }
  const jig = (v, k) => (v > 0 ? v * (1 + (seededRand(`${m.id}:${k}:${bucket}`) - 0.5) * 2 * noise) : 0);
  const norm = (arr, tag) => { const x = arr.map((v, i) => jig(v, tag + i)), t = x.reduce((a, b) => a + b, 0) || 1; return x.map((v) => v / t); };
  return { exact: norm(exact, "e"), res: norm(res, "r") };
}
const rateOf = (p, lo, hi) => +(lo + (hi - lo) * (1 - Math.min(1, Math.max(0, p)))).toFixed(2);
/** نسب الربح (٪) لكل خيار: { exact: [17], res: [3] } */
function ratesOf(m) {
  const { lo, hi } = rateBounds(), pr = matchProbs(m), man = m.manualRates || {};
  const pick = (mk, probs) => probs.map((p, i) => (Array.isArray(man[mk]) && Number.isFinite(Number(man[mk][i])) ? +clampN(man[mk][i], lo, hi, hi).toFixed(2) : rateOf(p, lo, hi)));
  return { exact: pick("exact", pr.exact), res: pick("res", pr.res), probs: pr };
}
const oddsFromRate = (rate) => +(1 + rate / 100).toFixed(4);   // عامل الدفع الداخلي: 1 + النسبة/100 (لا يُعرض كمضاعف)
const matchView = (m) => {
  const v = matchViewBase(m);
  const rt = ratesOf(m);
  const live = m.status === "live";
  return {
    ...v, rates: rt.exact, rRates: rt.res,
    chances: rt.probs.exact.map((x) => +x.toFixed(4)), rChances: rt.probs.res.map((x) => +x.toFixed(4)),
    dead: live ? deadOf(m) : null, suspendUntil: m.suspendUntil || 0,
    manualRates: m.manualRates || null,
  };
};
const withOdds = (m, pools) => ({
  ...m, pools,
  oddsHistory: m.oddsHistory.map((h, i) => [...h.slice(-19), +oddsOf(pools, i, m.boosted, feeOf(m)).toFixed(3)]),
});
const findMatch = (ms, id) => ms.find((m) => m.id === id);

/* ============================ المال والرهانات ============================ */
async function debit(userId, amount) {
  const { users } = await C();
  return fau(users, { _id: userId, balance: { $gte: amount } }, { $inc: { balance: -amount } });
}
async function credit(userId, amount) {
  const { users } = await C();
  return fau(users, { _id: userId }, { $inc: { balance: amount } });
}
async function autoDepositCheck(userId) {
  return; // ⛔ معطّل: كان يضيف رصيداً وهمياً بلا دفع حقيقي. الإيداع الحقيقي عبر /api/deposit/*
  // eslint-disable-next-line no-unreachable
  const cfg = await getConfig();
  const { users } = await C();
  const u = await users.findOne({ _id: userId });
  if (!u) return;
  const ad = u.autoDeposit;
  if (!ad?.enabled || !cfg.settings.autoDepositEnabled || u.frozen || u.balance >= ad.threshold) return;
  const depositedToday = ad.capDate === todayKey() ? ad.depositedToday : 0;
  const room = ad.dailyCap - depositedToday;
  if (room <= 0) return;
  const amount = Math.min(ad.amount, room);
  const method = cfg.payments.find((p) => p.id === ad.method) || cfg.payments[0];
  // شرط الرصيد يمنع تعبئتين متزامنتين
  const upd = await fau(users, { _id: userId, balance: { $lt: ad.threshold } },
    { $inc: { balance: amount }, $set: { "autoDeposit.capDate": todayKey(), "autoDeposit.depositedToday": depositedToday + amount } });
  if (!upd) return;
  await addTx(userId, { kind: "deposit", amount, label: `إيداع تلقائي عبر ${method.name}`, method: method.id });
  await addNotice(userId, { title: "⚡ تمت التعبئة تلقائياً", body: `رصيدك نزل تحت $${ad.threshold} فأعدنا تعبئته بـ $${amount}.`, tone: "gold" });
}
/** تسوية رهانات المباريات المنتهية (كل رهان يُحجز ذرّياً فلا يُسوّى مرتين) */
async function settleBets(endedIds, matches, { userId, onlyBetId } = {}) {
  const { bets, users } = await C();
  const filter = { status: "open", matchId: { $in: [...endedIds] } };
  if (userId !== undefined) filter.userId = userId;
  if (onlyBetId) filter._id = onlyBetId;
  const list = await bets.find(filter).sort({ createdAt: 1 }).toArray();
  const events = [];
  for (const b of list) {
    const m = findMatch(matches, b.matchId);
    if (!m) continue;
    const u = await users.findOne({ _id: b.userId });
    if (!u) continue;
    const scoreStr = m.score[0] <= 3 && m.score[1] <= 3 ? `${m.score[0]}-${m.score[1]}` : "أخرى";
    if (b.market === "result" ? RES_PICKS[resultIdx(m.score)] === b.pick : scoreStr === b.pick) {
      const payout = payoutOf(b.stake, b.odds, streakBonus(u.streak || 0));
      const claimed = await fau(bets, { _id: b._id, status: "open" }, { $set: { status: "won", payout, settledAt: Date.now() } });
      if (!claimed) continue;
      await users.updateOne({ _id: u._id }, {
        $inc: { balance: payout, streak: 1, vipXp: Math.round(b.stake) },
        $set: { bestStreak: Math.max(u.bestStreak || 0, (u.streak || 0) + 1) },
      });
      await addTx(u._id, { kind: "win", amount: payout, label: `فوز ${b.matchLabel} — ${pickText(b, m)}` });
      await addNotice(u._id, { title: `🏆 فزت $${payout}!`, body: `${b.matchLabel} انتهت ${scoreStr} وتوقّعك ${pickText(b, m)} أصاب!`, tone: "success" });
      events.push({ userId: u._id, betId: b._id, status: "won" });
    } else {
      const claimed = await fau(bets, { _id: b._id, status: "open" }, { $set: { status: "lost", payout: 0, settledAt: Date.now() } });
      if (!claimed) continue;
      await users.updateOne({ _id: u._id }, { $set: { streak: 0 } });
      await addNotice(u._id, { title: "انتهى الرهان", body: `${b.matchLabel} انتهت ${scoreStr} — حظاً أوفر في القادمة.`, tone: "alert" });
      events.push({ userId: u._id, betId: b._id, status: "lost" });
    }
    await autoDepositCheck(u._id);
  }
  return events;
}
async function cashoutQuote(u, b, cfg, ms) {
  if (!cfg.settings.cashoutEnabled || u.frozen || b.status !== "open") return null;
  const m = findMatch(ms, b.matchId);
  if (!m) return null;
  const margin = 1 - (cfg.settings.cashoutMarginPct || 0) / 100;
  if (m.status !== "live") return r2(b.stake * 0.97 * margin);   // قبل البداية: ما يقارب المبلغ
  if (b.market !== "result" && deadOf(m)[b.optIndex]) return null;   // الرهان المستحيل = لا كاش أوت
  const pr = matchProbs(m), p = (b.market === "result" ? pr.res : pr.exact)[b.optIndex] || 0;
  return r2(Math.max(0, b.stake * b.odds * p * 0.98) * margin);   // قيمة عادلة = الدفع المحتمل × احتمال الفوز الآن
}
/** استرداد رهان مفتوح (إلغاء/حذف مباراة) */
async function refundBet(b, label) {
  const { bets } = await C();
  const claimed = await fau(bets, { _id: b._id, status: "open" }, { $set: { status: "cashedout", payout: b.stake, settledAt: Date.now() } });
  if (!claimed) return false;
  await credit(b.userId, b.stake);
  await addTx(b.userId, { kind: "refund", amount: b.stake, label: `${label} ${b.matchLabel}` });
  await mutateState((ms) => ms.map((m) => {
    if (m.id !== b.matchId) return m;
    if (b.market === "result") {
      const rp = rPoolsOf(m).slice();
      rp[b.optIndex] = Math.max(1, rp[b.optIndex] - b.stake);
      return { ...m, rPools: rp };
    }
    const pools = m.pools.slice();
    pools[b.optIndex] = Math.max(1, pools[b.optIndex] - b.stake);
    return withOdds(m, pools);
  })).catch(() => undefined);
  return true;
}

/* ---- لوحة الترتيب ---- */
async function leaderboard(limit, myId) {
  const { users } = await C();
  const real = (await users.find({}).sort({ balance: -1 }).limit(100).toArray())
    .map((u) => ({ id: String(u._id), name: u.name, avatar: u.avatar, balance: r2(u.balance), real: true }));
  // الترتيب من لاعبين حقيقيين فقط (بلا لاعبين وهميين)
  const all = real.map((u, i) => ({ ...u, rank: i + 1 }));
  let me = all.find((u) => u.id === String(myId)) || null;
  if (!me) {
    const mine = await users.findOne({ _id: myId });
    if (mine) {
      const above = await users.countDocuments({ balance: { $gt: mine.balance } });
      me = { id: String(mine._id), name: mine.name, avatar: mine.avatar, balance: r2(mine.balance), real: true, rank: above + 1 };
    }
  }
  return { board: all.slice(0, limit), me };
}

/* ============================ المسارات ============================ */
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === "function") { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ method, re, keys, handler, ...opts });
}
const PUBLIC_R = { auth: false };

/* ---- عام ---- */
route("GET", "/api/health", { auth: false, sync: false }, async () => {
  const { users } = await C();
  return { ok: true, time: Date.now(), db: "up", users: await users.countDocuments({}) };
});
route("GET", "/api/config", { auth: false, sync: false }, async ({ cfg }) => {
  const s = cfg.settings;
  return {
    maintenance: s.maintenance, maintenanceMsg: s.maintenanceMsg, announcement: s.announcement,
    bettingEnabled: s.bettingEnabled, depositsEnabled: s.depositsEnabled, withdrawalsEnabled: s.withdrawalsEnabled,
    liveBetting: s.liveBetting, liveCutoffMin: s.liveCutoffMin, goalPauseSec: s.goalPauseSec, cashoutEnabled: s.cashoutEnabled, cancelEnabled: s.cancelEnabled,
    platformFeePct: s.platformFeePct, minStake: s.minStake, maxStake: s.maxStake, minWithdraw: s.minWithdraw, maxWithdraw: s.maxWithdraw, minDeposit: s.minDeposit, maxDeposit: s.maxDeposit,
    dailyBonusEnabled: s.dailyBonusEnabled, commissionEnabled: s.commissionEnabled, autoDepositEnabled: s.autoDepositEnabled,
    bonusBase: s.bonusBase, bonusPerStreak: s.bonusPerStreak, bonusCooldownHours: s.bonusCooldownHours,
    bonusSectionTitle: s.bonusSectionTitle, bonusTitle: s.bonusTitle, celebrations: s.celebrations,
    supportEnabled: s.supportEnabled, supportUrl: s.supportUrl, supportTipTitle: s.supportTipTitle, supportTipText: s.supportTipText,
    noticeEnabled: s.noticeEnabled, noticeShowLive: s.noticeShowLive, noticeText: s.noticeText,
    simSpeedMs: s.simSpeedMs, leagues: cfg.leagues, vipTiers: cfg.vipTiers, payments: cfg.payments.filter((p) => p.enabled),
  };
});
route("GET", "/api/leagues", PUBLIC_R, ({ cfg }) => cfg.leagues);
route("GET", "/api/payments", PUBLIC_R, ({ cfg }) => cfg.payments.filter((p) => p.enabled));
route("GET", "/api/vip/tiers", PUBLIC_R, ({ cfg }) => cfg.vipTiers);

/* ---- المباريات ---- */
route("GET", "/api/matches", PUBLIC_R, ({ query, matches, cfg }) => {
  let list = cfg.settings.showSimMatches === false ? matches.filter((m) => m.real) : matches;
  if (query.league) list = list.filter((m) => m.leagueId === query.league);
  if (query.status) list = list.filter((m) => m.status === query.status);
  if (query.hot === "1") list = list.filter((m) => m.hot);
  return list.map(matchView);
});
/* خفيف للاستعلام الدوري (بديل البث الحي): دقائق + نتائج + أسعار */
route("GET", "/api/ticker", PUBLIC_R, ({ matches }) => ({
  at: Date.now(),
  matches: matches.map((m) => {
    const rt = ratesOf(m);
    return {
      id: m.id, status: m.status, minute: m.minute, score: m.score,
      rates: rt.exact, rRates: rt.res,   // rRates = نسب فوز الفريقين/التعادل (كانت مفقودة فلا تتحدّث في الواجهة)
      manualRates: m.manualRates || null, totalPool: Math.round(totalPool(m.pools)),
    };
  }),
}));
route("GET", "/api/matches/:id", PUBLIC_R, ({ params, matches }) => {
  const m = findMatch(matches, params.id);
  if (!m) throw notFound("المباراة غير موجودة");
  return matchView(m);
});
route("GET", "/api/matches/:id/odds", PUBLIC_R, ({ params, matches }) => {
  const m = findMatch(matches, params.id);
  if (!m) throw notFound("المباراة غير موجودة");
  const rt = ratesOf(m);   // النسبة = صافي الربح ٪؛ الدفع = المبلغ × (1 + النسبة/100)
  return rt.exact.map((rate, i) => ({ index: i, pick: SCORES[i], rate, payoutFactor: oddsFromRate(rate) }));
});
route("GET", "/api/stream", { auth: false, sync: false }, () => {
  throw new HttpError(410, "البث الحي (SSE) غير مدعوم على Vercel — استعلم من /api/ticker كل ثانيتين تقريباً");
});

/* ============================ بوت تيليجرام — رسالة الترحيب /start ============================
 * مسار مستقل تماماً (POST /api/telegram/webhook) لا يمسّ أي مسار آخر ولا يحتاج مزامنة المباريات.
 * التفعيل (مرة واحدة) — افتح هذا الرابط في المتصفح بعد النشر:
 *   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<نطاقك>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 * متغيّرات اختيارية: TELEGRAM_WEBHOOK_SECRET (يُنصح به — يمنع أي طرف غير تيليجرام من استدعاء المسار)
 * ملاحظة: أزرار web_app لا تعمل إلا في المحادثة الخاصة، لذا نردّ على /start في الخاص فقط.
 */
async function tgCall(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN غير مضبوط");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
async function sendWelcome(chatId) {
  // رسالة الترحيب الخاصة بمنصة sporfa للاستثمار الرياضي الذكي
  const welcomeText = `*✅ مرحباً بك في منصتنا الرائدة sporfa للاستثمار الرياضي الذكي! 📈\n​نحن نمثل الجيل القادم من المنصات الرقمية التي تدمج بين شغف كرة القدم وفرص النمو المالي الحقيقي. نهدف إلى تمكين مستخدمينا من بناء عوائد مستدامة عبر نظام استثماري مدروس يعتمد على استراتيجيات رياضية وخطط يومية مرنة 👋*`;

  await tgCall('sendMessage', {
    chat_id: chatId,
    text: welcomeText,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'اضغط هنا لتبدأ الربح 📈', web_app: { url: 'https://exquisite-sorbet-b586b5.netlify.app/' } }], // زر فتح التطبيق بالرابط المباشر والنص الجديد
        [{ text: '💎 اشترك في قناتنا', url: 'https://t.me/aporfachannel' }],                  // رابط القناة
        [{ text: '👥 انضم لمجموعتنا', url: 'https://t.me/sporfaa' }],         // رابط المجموعة
      ],
    },
  });
}
route("POST", "/api/telegram/webhook", { auth: false, sync: false }, async ({ req, body }) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) throw new HttpError(401, "غير مصرّح");
  try {
    const msg = body?.message;
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    // /start و/start@BotName و/start ref_xxx كلها تُظهر الترحيب
    if (msg?.chat?.type === "private" && /^\/start(@\w+)?(\s|$)/i.test(text)) {
      const ref = text.match(/^\/start(?:@\w+)?\s+ref_(\S+)/i);
      if (ref && msg.from?.id) {
        console.log(`referral: /start من ${msg.from.id} بكود ${ref[1]}`);
        await savePendingRef(msg.from.id, ref[1]).catch((e) => console.error("savePendingRef:", e?.message || e));
      }
      await sendWelcome(msg.chat.id);
    }
  } catch (e) {
    console.error("telegram webhook:", e?.message || e);   // لا نُرجع خطأ حتى لا يعيد تيليجرام الإرسال بلا نهاية
  }
  return { ok: true };
});

/* ---- الحساب ---- */
async function attachReferral(user, code) {
  if (user.referredBy || !code) return;
  const { users, refs } = await C();
  const inviterId = inviterIdFromCode(code);
  if (!inviterId) { console.error(`referral: كود غير صالح "${code}" للمستخدم ${user._id}`); return; }
  if (inviterId === user._id) { console.error(`referral: المستخدم ${user._id} حاول دعوة نفسه`); return; }
  const inviter = await users.findOne({ _id: inviterId });
  if (!inviter) { console.error(`referral: الداعي ${inviterId} غير موجود (لم يفتح التطبيق بعد)`); return; }
  // منع الحلقات: لا يُقبل داعٍ يكون المستخدم نفسه من أسلافه (3 مستويات)
  let up = inviter._id;
  for (let i = 0; i < 3 && up; i++) {
    const r = await refs.findOne({ userId: up });
    if (!r) break;
    if (r.inviterId === user._id) return;
    up = r.inviterId;
  }
  const claimed = await fau(users, { _id: user._id, referredBy: null }, { $set: { referredBy: inviter._id } });
  if (!claimed) return;
  try {
    await refs.insertOne({ _id: `r${uid()}`, inviterId: inviter._id, userId: user._id, name: user.name, avatar: user.avatar, joinedAt: Date.now(), wagered: 0, commissionEarned: 0, active: false, qualified: false });
    await addNotice(inviter._id, { title: "👥 صديق جديد انضم", body: `${user.name} انضم عبر رابط دعوتك.`, tone: "info" });
    console.log(`referral: تم ربط ${user._id} بالداعي ${inviter._id}`);
  } catch (e) { console.error("referral insert:", e?.message || e); /* مُحال مسبقاً */ }
}
/* إحالة معلّقة: تُحفظ عند ضغط الصديق Start في البوت (/start ref_CODE) وتُربط بحسابه عند أول دخول للتطبيق.
 * بهذا لا تعتمد الإحالة على طريقة فتح التطبيق (start_param) ولا على الاسم المختصر للتطبيق في BotFather. */
const PENDING_REF_TTL = 30 * 24 * 3600_000;
async function savePendingRef(tgId, code) {
  if (!tgId || !code) return;
  const { meta } = await C();
  await meta.updateOne({ _id: `pref:${tgId}` }, { $set: { code: String(code).slice(0, 40), at: Date.now() } }, { upsert: true });
}
async function claimPendingRef(user) {
  if (!user?._id || user.referredBy) return;
  const { meta } = await C();
  const doc = await meta.findOne({ _id: `pref:${user._id}` });
  if (!doc) return;
  if (Date.now() - (doc.at || 0) <= PENDING_REF_TTL) await attachReferral(user, doc.code);
  await meta.deleteOne({ _id: doc._id });
}
route("POST", "/api/auth/telegram", async ({ user, body, cfg, req }) => {
  // الإحالة تُحتسب فقط عند دخول المدعو إلى التطبيق عبر تيليجرام (حساب حقيقي بتوقيع موثّق)، لا كضيف
  if (body?.ref && user._id && req.headers["x-telegram-init-data"]) await attachReferral(user, String(body.ref).replace(/^ref_/, ""));
  if (user._id && req.headers["x-telegram-init-data"]) await claimPendingRef((await (await C()).users.findOne({ _id: user._id })) || user).catch((e) => console.error("claimPendingRef:", e?.message || e));
  const { users } = await C();
  return { user: publicUser(await users.findOne({ _id: user._id }), cfg) };
});
route("GET", "/api/me", ({ user, cfg }) => ({
  user: publicUser(user, cfg), autoDeposit: user.autoDeposit, limits: user.limits,
  unreadNotices: user.notices.filter((n) => !n.read).length,
}));
route("PATCH", "/api/me", async ({ user, body, cfg }) => {
  const set = {};
  if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim().slice(0, 40);
  if (typeof body.avatar === "string" && body.avatar.trim()) set.avatar = body.avatar.trim().slice(0, 8);
  const { users } = await C();
  const u = Object.keys(set).length ? await fau(users, { _id: user._id }, { $set: set }) : user;
  return { user: publicUser(u, cfg) };
});

/* ---- المحفظة ---- */
function bonusState(u, cfg) {
  const s = cfg.settings, cd = (s.bonusCooldownHours || 24) * 3600_000;
  const readyAt = (u.lastBonusAt || 0) + cd;
  return { enabled: s.dailyBonusEnabled, available: s.dailyBonusEnabled && Date.now() >= readyAt, readyAt, amount: r2(s.bonusBase + (u.streak || 0) * s.bonusPerStreak), cooldownMs: cd };
}
route("GET", "/api/wallet", ({ user, cfg }) => ({
  balance: r2(user.balance), autoDeposit: user.autoDeposit, limits: user.limits,
  payments: cfg.payments.filter((p) => p.enabled), bonus: bonusState(user, cfg),
}));
route("GET", "/api/wallet/transactions", async ({ user, query }) => {
  const { txs } = await C();
  const f = { userId: user._id };
  if (query.kind) f.kind = String(query.kind);
  return (await txs.find(f).sort({ at: -1 }).limit(Math.min(Number(query.limit) || 200, 200)).toArray()).map((t) => pub(t));
});
route("POST", "/api/wallet/deposit", async ({ user, body, cfg }) => {
  assertActive(user, cfg);
  if (!cfg.settings.depositsEnabled) throw forbid("الإيداع متوقف حالياً");
  const amount = Number(body.amount);
  const m = cfg.payments.find((p) => p.id === body.method);
  if (!m) throw bad("طريقة دفع غير معروفة");
  if (!m.enabled) throw bad("طريقة الدفع هذه متوقفة حالياً");
  if (!Number.isFinite(amount) || amount < m.minDeposit || amount > m.maxDeposit) {
    throw bad(`المبلغ يجب أن يكون بين $${m.minDeposit} و $${m.maxDeposit} لـ ${m.name}`);
  }
  // ⛔ معطّل: هذا المسار كان يمنح رصيداً بلا أي تحقق. الإيداع الحقيقي عبر /api/deposit/orders (USDT TRC-20)
  throw forbid("الإيداع يتم تلقائياً عبر USDT TRC-20 من صفحة تعبئة الرصيد");
  // eslint-disable-next-line no-unreachable
  const u = await credit(user._id, amount);
  const tx = await addTx(user._id, { kind: "deposit", amount, label: `إيداع عبر ${m.name}`, method: m.id });
  await addNotice(user._id, { title: "✅ تم الإيداع", body: `$${amount} عبر ${m.name} — رصيدك الآن $${r2(u.balance)}.`, tone: "success" });
  return { ok: true, tx: pub(tx), balance: r2(u.balance) };
});
route("POST", "/api/wallet/withdraw", async ({ user, body, cfg }) => {
  assertActive(user, cfg);
  const s = cfg.settings;
  if (!s.withdrawalsEnabled) throw forbid("السحب متوقف حالياً");
  const amount = Number(body.amount);
  const m = cfg.payments.find((p) => p.id === body.method);
  if (!m) throw bad("طريقة دفع غير معروفة");
  if (!Number.isFinite(amount) || amount <= 0) throw bad("أدخل مبلغاً صحيحاً");
  if (amount < s.minWithdraw) throw bad(`أدنى مبلغ للسحب هو $${s.minWithdraw}`);
  if (s.maxWithdraw > 0 && amount > s.maxWithdraw) throw bad(`أقصى مبلغ للسحب $${s.maxWithdraw}`);
  const u = await debit(user._id, amount);
  if (!u) throw bad("المبلغ يتجاوز رصيدك المتاح");
  const tx = await addTx(user._id, { kind: "withdraw", amount: -amount, label: `سحب عبر ${m.name}`, method: m.id, status: s.withdrawAutoApprove ? "done" : "pending" });
  await addNotice(user._id, { title: "🏦 طلب سحب قيد المعالجة", body: `$${amount} عبر ${m.name} — الوصول خلال ${m.eta}.`, tone: "info" });
  return { ok: true, tx: pub(tx), balance: r2(u.balance) };
});
route("PUT", "/api/wallet/auto-deposit", async ({ user, body, cfg }) => {
  const p = body || {}, set = {};
  if (typeof p.enabled === "boolean") set["autoDeposit.enabled"] = p.enabled;
  for (const k of ["threshold", "amount", "dailyCap"]) if (p[k] !== undefined) {
    const n = Number(p[k]); if (!Number.isFinite(n) || n < 0) throw bad(`قيمة ${k} غير صحيحة`);
    set[`autoDeposit.${k}`] = n;
  }
  if (p.method !== undefined) {
    if (!cfg.payments.some((x) => x.id === p.method)) throw bad("طريقة دفع غير معروفة");
    set["autoDeposit.method"] = p.method;
  }
  const { users } = await C();
  if (Object.keys(set).length) await users.updateOne({ _id: user._id }, { $set: set });
  await autoDepositCheck(user._id);
  const u = await users.findOne({ _id: user._id });
  return { autoDeposit: u.autoDeposit, balance: r2(u.balance) };
});
route("PUT", "/api/limits", async ({ user, body }) => {
  const p = body || {}, set = {};
  for (const k of ["dailyLossLimit", "maxStake"]) if (p[k] !== undefined) {
    const n = Number(p[k]); if (!Number.isFinite(n) || n < 0) throw bad(`قيمة ${k} غير صحيحة`);
    set[`limits.${k}`] = n;
  }
  if (p.selfExcludedUntil !== undefined) set["limits.selfExcludedUntil"] = p.selfExcludedUntil ? Number(p.selfExcludedUntil) : null;
  const { users } = await C();
  if (Object.keys(set).length) await users.updateOne({ _id: user._id }, { $set: set });
  return { limits: (await users.findOne({ _id: user._id })).limits };
});

/* ---- الرهانات ---- */
route("GET", "/api/bets", async ({ user, query, cfg, matches }) => {
  const { bets } = await C();
  // شبكة أمان: تسوية أي رهان مفتوح لمباراة منتهية (لو فشلت التسوية سابقاً)
  const open = await bets.find({ userId: user._id, status: "open" }).toArray();
  const endedIds = new Set(open.filter((b) => findMatch(matches, b.matchId)?.status === "ended").map((b) => b.matchId));
  if (endedIds.size) await settleBets(endedIds, matches, { userId: user._id });
  const f = { userId: user._id };
  if (query.status === "open") f.status = "open";
  else if (query.status === "settled") f.status = { $ne: "open" };
  else if (query.status) f.status = String(query.status);
  const list = await bets.find(f).sort({ createdAt: -1 }).limit(300).toArray();
  const u = await (await C()).users.findOne({ _id: user._id });
  return Promise.all(list.map(async (b) => ({ ...pub(b), cashoutQuote: b.status === "open" ? await cashoutQuote(u, b, cfg, matches) : null })));
});
route("POST", "/api/bets", async ({ user, body, cfg, matches }) => {
  assertActive(user, cfg);
  const s = cfg.settings, stake = Number(body.stake);
  const market = body.market === "result" ? "result" : "exact";
  const optIndex = market === "result"
    ? (body.optIndex !== undefined ? Number(body.optIndex) : RES_PICKS.indexOf(String(body.pick).toUpperCase()))
    : (body.optIndex !== undefined ? Number(body.optIndex) : SCORES.indexOf(body.pick));
  const m0 = findMatch(matches, body.matchId);
  if (!m0) throw bad("المباراة غير متوفرة");
  if (!Number.isInteger(optIndex) || optIndex < 0 || optIndex >= (market === "result" ? 3 : OPT_COUNT)) throw bad("خيار غير صالح");
  const checkMatch = (m) => {
    if (!s.bettingEnabled) throw forbid("الرهان متوقف حالياً");
    if (m.suspended) throw bad("الرهان على هذه المباراة موقوف مؤقتاً");
    if (m.status === "ended") throw bad("المباراة انتهت");
    if (m.status === "live" && !s.liveBetting) throw bad("الرهان أثناء المباراة متوقف حالياً");
    if (m.status === "live" && m.real) {
      if (m.minute >= (Number(s.liveCutoffMin) || 90)) throw bad("أُغلق الرهان قرب نهاية المباراة");
      if (m.suspendUntil && Date.now() < m.suspendUntil) throw bad("تم تسجيل هدف — الرهان متوقف لحظات");
    }
  };
  checkMatch(m0);
  if (!(stake > 0)) throw bad("أدخل مبلغاً صحيحاً");
  if (stake < s.minStake) throw bad(`أدنى رهان $${s.minStake}`);
  if (s.maxStake > 0 && stake > s.maxStake) throw bad(`أقصى رهان $${s.maxStake}`);
  if (stake > user.balance) throw bad("رصيدك غير كافٍ");
  if (user.limits.maxStake > 0 && stake > user.limits.maxStake) throw bad(`حد الرهان الأقصى لديك $${user.limits.maxStake}`);
  if (user.limits.selfExcludedUntil && Date.now() < user.limits.selfExcludedUntil) throw forbid("أنت في فترة إيقاف ذاتي");
  const { bets, refs } = await C();
  if (user.limits.dailyLossLimit > 0) {
    const since = new Date().setHours(0, 0, 0, 0);
    const today = await bets.find({ userId: user._id, status: "lost", compensated: { $ne: true }, createdAt: { $gte: since } }).toArray();
    if (today.reduce((a, b) => a + b.stake, 0) >= user.limits.dailyLossLimit) throw forbid("بلغت حد الخسارة اليومي");
  }
  // 1) خصم ذرّي  2) إضافة للمجمّع بسعر لحظي  3) تسجيل الرهان — وإن فشلت خطوة نُعيد المبلغ
  const after = await debit(user._id, stake);
  if (!after) throw bad("رصيدك غير كافٍ");
  let odds, matchLabel, boosted;
  try {
    await mutateState((ms) => {
      const m = findMatch(ms, m0.id);
      if (!m) throw bad("المباراة غير متوفرة");
      checkMatch(m);
      if (market === "exact" && m.status === "live" && deadOf(m)[optIndex]) throw bad("هذه النتيجة لم تعد ممكنة");
      matchLabel = `${m.home.name} × ${m.away.name}`;
      boosted = m.boosted;
      if (market === "result") {
        const rp = rPoolsOf(m).slice();
        odds = oddsFromRate(ratesOf(m).res[optIndex]);   // الربح = النسبة المعروضة لحظة الرهان (تُقفل مع الرهان)
        rp[optIndex] += stake;
        return ms.map((x) => (x.id === m.id ? { ...x, rPools: rp } : x));
      }
      odds = oddsFromRate(ratesOf(m).exact[optIndex]);
      const pools = m.pools.slice(); pools[optIndex] += stake;
      return ms.map((x) => (x.id === m.id ? { ...x, pools, oddsHistory: x.oddsHistory.map((h, i) => (i === optIndex ? [...h.slice(-19), +odds.toFixed(3)] : h)) } : x));
    });
  } catch (e) {
    await credit(user._id, stake);
    throw e;
  }
  const bet = {
    _id: uid(), userId: user._id, matchId: m0.id, matchLabel, market, pick: market === "result" ? RES_PICKS[optIndex] : SCORES[optIndex], optIndex, stake, odds,
    status: "open", payout: 0, createdAt: Date.now(), streakBonus: streakBonus(user.streak || 0),
  };
  await bets.insertOne(bet);
  await addTx(user._id, { kind: "bet", amount: -stake, label: `رهان ${matchLabel} — ${pickText(bet, m0)}` });
  if (user.referredBy && s.commissionEnabled) {
    // العمولة 3 مستويات (10% / 5% / 3% من مبلغ الرهان) ولا تُفعَّل إلا بعد «التأهيل»:
    // استلام المدعو مكافأة الدعوة (5$) من الإدارة، وتُحتسب على رهاناته اللاحقة فقط — بلا أثر رجعي
    const ref = await refs.findOne({ userId: user._id });
    if (ref) {
      const inc = { wagered: stake };
      if (ref.qualified === true) {
        inc.commissionEarned = r2(stake * REF_RATES[0]);                 // المستوى 1: من دعاه مباشرة
        const up1 = await refs.findOne({ userId: ref.inviterId });       // المستوى 2: من دعا الداعي
        if (up1) {
          inc.commissionL2 = r2(stake * REF_RATES[1]);
          const up2 = await refs.findOne({ userId: up1.inviterId });     // المستوى 3
          if (up2) inc.commissionL3 = r2(stake * REF_RATES[2]);
        }
      }
      await refs.updateOne({ userId: user._id }, { $inc: inc, $set: { active: true } });
    }
  }
  await autoDepositCheck(user._id);
  const u = await (await C()).users.findOne({ _id: user._id });
  return { ok: true, bet: pub(bet), balance: r2(u.balance) };
});
async function findBet(user, id) {
  const { bets } = await C();
  const b = await bets.findOne({ _id: id, userId: user._id });
  if (!b) throw notFound("الرهان غير موجود");
  return b;
}
route("POST", "/api/bets/:id/cancel", async ({ user, params, cfg, matches }) => {
  assertActive(user, cfg);
  const b = await findBet(user, params.id);
  if (b.status !== "open") throw bad("لا يمكن إلغاء هذا الرهان");
  if (!cfg.settings.cancelEnabled) throw forbid("إلغاء الرهان متوقف");
  const m = findMatch(matches, b.matchId);
  if (m && m.status !== "upcoming") throw bad("لا يمكن الإلغاء بعد انطلاق المباراة");
  await refundBet(b, "إلغاء رهان");
  const u = await (await C()).users.findOne({ _id: user._id });
  return { ok: true, balance: r2(u.balance), bet: pub(await findBet(user, b._id)) };
});
route("GET", "/api/bets/:id/cashout", async ({ user, params, cfg, matches }) => {
  const b = await findBet(user, params.id);
  const quote = await cashoutQuote(user, b, cfg, matches);
  if (quote == null) throw bad("الكاش أوت غير متاح لهذا الرهان");
  return { betId: b._id, quote, expiresInMs: 4000 };
});
route("POST", "/api/bets/:id/cashout", async ({ user, params, body, cfg, matches }) => {
  assertActive(user, cfg);
  const b = await findBet(user, params.id);
  const quote = await cashoutQuote(user, b, cfg, matches);
  if (quote == null) throw bad("الكاش أوت غير متاح لهذا الرهان");
  if (body?.value !== undefined && Math.abs(Number(body.value) - quote) > Math.max(0.5, quote * 0.1)) {
    throw new HttpError(409, `تغيّر السعر — القيمة الحالية $${quote}`);
  }
  const { bets } = await C();
  const claimed = await fau(bets, { _id: b._id, status: "open" }, { $set: { status: "cashedout", payout: quote, cashoutValue: quote, settledAt: Date.now() } });
  if (!claimed) throw bad("تمت تسوية الرهان بالفعل");
  const u = await credit(user._id, quote);
  await addTx(user._id, { kind: "cashout", amount: quote, label: "كاش أوت مبكر" });
  return { ok: true, payout: quote, balance: r2(u.balance), bet: pub(claimed) };
});
route("POST", "/api/bets/:id/settle", { admin: true }, async ({ params, body, matches }) => {
  const { bets } = await C();
  const b = await bets.findOne({ _id: params.id });
  if (!b) throw notFound("الرهان غير موجود");
  if (b.status !== "open") throw bad("الرهان مسوّى بالفعل");
  const m = findMatch(matches, b.matchId);
  if (!m) throw notFound("المباراة غير موجودة");
  if (m.status !== "ended") {
    if (body?.result === "refund") { await refundBet(b, "استرداد"); return { ok: true }; }
    throw bad("المباراة لم تنتهِ بعد");
  }
  const events = await settleBets(new Set([m.id]), matches, { onlyBetId: b._id });
  return { ok: true, events, bet: pub(await bets.findOne({ _id: b._id })) };
});

/* ---- المكافأة اليومية ---- */
route("GET", "/api/bonus/daily", ({ user, cfg }) => bonusState(user, cfg));
route("POST", "/api/bonus/daily", async ({ user, cfg }) => {
  assertActive(user, cfg);
  const st = bonusState(user, cfg);
  if (!st.enabled) throw forbid("المكافأة اليومية متوقفة");
  if (!st.available) throw bad("المكافأة غير متاحة بعد");
  const { users } = await C();
  const now = Date.now();
  const u = await fau(users, { _id: user._id, lastBonusAt: { $lte: now - st.cooldownMs } }, { $inc: { balance: st.amount }, $set: { lastBonusAt: now } });
  if (!u) throw bad("المكافأة غير متاحة بعد");
  await addTx(user._id, { kind: "bonus", amount: st.amount, label: "مكافأة الوفاء اليومية" });
  await addNotice(user._id, { title: "🎁 مكافأة يومية", body: `استلمت $${st.amount} — تعود كل 24 ساعة.`, tone: "gold" });
  return { ok: true, amount: st.amount, balance: r2(u.balance) };
});

/* ---- الترتيب / VIP / السجل / الإحالات / الإشعارات ---- */
route("GET", "/api/leaderboard", ({ user, query }) => leaderboard(Math.min(Number(query.limit) || 50, 100), user._id));
route("GET", "/api/vip", ({ user, cfg }) => ({ vipXp: user.vipXp, ...vipOf(user.vipXp, cfg), tiers: cfg.vipTiers }));
route("GET", "/api/history", async ({ user, query }) => {
  const { bets, txs } = await C();
  const limit = Math.min(Number(query.limit) || 100, 200);
  return {
    bets: (await bets.find({ userId: user._id }).sort({ createdAt: -1 }).limit(limit).toArray()).map((b) => pub(b)),
    transactions: (await txs.find({ userId: user._id }).sort({ at: -1 }).limit(limit).toArray()).map((t) => pub(t)),
  };
});
/* شبكة المستخدم بمستوياتها الثلاثة؛ commissionEarned = ما يكسبه هذا المستخدم من العضو عند مستواه */
async function refsOf(userId) {
  const { refs } = await C();
  const out = [];
  let parents = [userId];
  for (let level = 1; level <= 3 && parents.length; level++) {
    const rows = await refs.find({ inviterId: { $in: parents } }).sort({ joinedAt: -1 }).limit(500).toArray();
    for (const r of rows) {
      const { _id, inviterId, commissionL2, commissionL3, ...rest } = r;
      const earned = level === 1 ? r.commissionEarned || 0 : level === 2 ? commissionL2 || 0 : commissionL3 || 0;
      out.push({ id: _id, ...rest, level, commissionEarned: r2(earned) });
    }
    parents = rows.map((r) => r.userId);
  }
  return out;
}
route("GET", "/api/referrals", async ({ user }) => {
  const list = await refsOf(user._id);
  const earned = r2(list.reduce((a, r) => a + r.commissionEarned, 0));
  const code = inviteCodeOf(user._id);
  return {
    code, link: `https://t.me/${BOT_USERNAME}?start=ref_${code}`, referrals: list,
    totalEarned: earned, claimed: r2(user.claimedCommission || 0), pending: r2(Math.max(0, earned - (user.claimedCommission || 0))),
  };
});
route("GET", "/api/referrals/link", ({ user }) => ({ link: `https://t.me/${BOT_USERNAME}?start=ref_${inviteCodeOf(user._id)}` }));
route("POST", "/api/referrals/claim", async ({ user, cfg }) => {
  assertActive(user, cfg);
  if (!cfg.settings.commissionEnabled) throw forbid("العمولة متوقفة");
  const list = await refsOf(user._id);
  const claimedBefore = user.claimedCommission || 0;
  const pending = r2(list.reduce((a, r) => a + r.commissionEarned, 0) - claimedBefore);
  if (pending <= 0.01) throw bad("لا توجد عمولة متاحة");
  const { users } = await C();
  const u = await fau(users, { _id: user._id, claimedCommission: claimedBefore }, { $inc: { balance: pending, claimedCommission: pending } });
  if (!u) throw bad("تم الاستلام بالفعل، أعد المحاولة");
  await addTx(user._id, { kind: "commission", amount: pending, label: "عمولة الإحالات" });
  return { ok: true, amount: pending, balance: r2(u.balance) };
});
route("GET", "/api/friends", async ({ user }) => {
  const { users } = await C();
  const list = await refsOf(user._id);
  return Promise.all(list.map(async (r) => {
    const f = await users.findOne({ _id: r.userId });
    return { ...r, balance: f ? r2(f.balance) : undefined };
  }));
});
route("GET", "/api/notices", ({ user }) => user.notices);
route("POST", "/api/notices/read", async ({ user }) => {
  const { users } = await C();
  await users.updateOne({ _id: user._id }, { $set: { notices: user.notices.map((n) => ({ ...n, read: true })) } });
  return { ok: true };
});
route("DELETE", "/api/notices/:id", async ({ user, params }) => {
  const { users } = await C();
  await users.updateOne({ _id: user._id }, { $set: { notices: user.notices.filter((n) => n.id !== params.id) } });
  return { ok: true };
});

/* ============================ لوحة الأدمن ============================ */
/* جلسة الأدمن: توكن موقّع (HMAC) بلا حالة في الخادم — يصلح مع Serverless */
const secretKey = () => process.env.ADMIN_SECRET || crypto.createHash("sha256").update(`tq:${ADMIN_PIN}:${process.env.MONGODB_URI || ""}`).digest("hex");
const b64 = (s) => Buffer.from(s).toString("base64url");
function signAdminToken(userId) {
  const payload = b64(JSON.stringify({ u: userId, exp: Date.now() + 2 * 3600_000 }));
  return `${payload}.${crypto.createHmac("sha256", secretKey()).update(payload).digest("hex")}`;
}
function verifyAdminToken(tok) {
  const [payload, sig] = String(tok || "").split(".");
  if (!payload || !sig) return null;
  const calc = crypto.createHmac("sha256", secretKey()).update(payload).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(payload, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
/* رمز الأدمن: إن غُيِّر من اللوحة يُحفظ مُجزَّأً (scrypt) في MongoDB ويتقدّم على ADMIN_PIN */
const pinHash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");
async function pinOk(pin) {
  const { meta } = await C();
  const doc = await meta.findOne({ _id: "adminpin" });
  if (doc?.hash) {
    const a = Buffer.from(pinHash(pin ?? "", doc.salt)), b = Buffer.from(doc.hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const a = Buffer.from(String(pin ?? "")), b = Buffer.from(ADMIN_PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* لوحة الأدمن موقع مستقل بلا تيليجرام: الدخول بالرمز فقط (مع قفل 30 ثانية بعد 5 محاولات خاطئة) */
route("POST", "/api/admin/login", { auth: false, sync: false }, async ({ body }) => {
  const { meta } = await C();
  const lock = (await meta.findOne({ _id: "adminlock" })) || { fails: 0, lockedUntil: 0 };
  if (Date.now() < (lock.lockedUntil || 0)) throw new HttpError(429, `محاولات كثيرة — انتظر ${Math.ceil((lock.lockedUntil - Date.now()) / 1000)} ثانية`);
  if (await pinOk(body?.pin)) {
    await meta.updateOne({ _id: "adminlock" }, { $set: { fails: 0, lockedUntil: 0 } }, { upsert: true });
    await adminLog("دخول إلى لوحة الإدارة");
    return { ok: true, token: signAdminToken(0), expiresInMs: 2 * 3600_000 };
  }
  const fails = (lock.fails || 0) + 1;
  await meta.updateOne({ _id: "adminlock" }, { $set: fails >= 5 ? { fails: 0, lockedUntil: Date.now() + 30_000 } : { fails } }, { upsert: true });
  throw new HttpError(401, "الرمز غير صحيح");
});
const A = { admin: true };
route("GET", "/api/admin/overview", A, async () => {
  const { users, bets, txs, state } = await C();
  const nowTs = Date.now();
  const [uCount, online, active24h, balAgg, openBets, betAgg, mAgg, pendingWithdrawals] = await Promise.all([
    users.estimatedDocumentCount(),
    users.countDocuments({ lastSeenAt: { $gte: nowTs - 90_000 } }),
    users.countDocuments({ lastSeenAt: { $gte: nowTs - 86_400_000 } }),
    users.aggregate([{ $group: { _id: null, t: { $sum: "$balance" } } }]).toArray(),
    bets.countDocuments({ status: "open" }),
    bets.aggregate([{ $group: { _id: null, n: { $sum: 1 }, w: { $sum: "$stake" } } }]).toArray(),
    state.aggregate([{ $match: { _id: "matches" } }, { $project: { n: { $size: { $ifNull: ["$matches", []] } }, live: { $size: { $filter: { input: { $ifNull: ["$matches", []] }, cond: { $eq: ["$$this.status", "live"] } } } } } }]).toArray(),
    txs.countDocuments({ kind: "withdraw", status: "pending" }),
  ]);
  return {
    users: uCount, online, active24h, serverTime: nowTs,
    balanceTotal: r2(balAgg[0]?.t || 0),
    openBets, totalBets: betAgg[0]?.n || 0, wagered: r2(betAgg[0]?.w || 0),
    matches: mAgg[0]?.n || 0, live: mAgg[0]?.live || 0,
    pendingWithdrawals,
  };
});
route("GET", "/api/admin/settings", A, ({ cfg }) => cfg.settings);
route("PUT", "/api/admin/settings", A, async ({ body, cfg }) => {
  const keys = Object.keys(body || {}).filter((k) => k in DEFAULT_SETTINGS);
  const settings = { ...cfg.settings };
  for (const k of keys) settings[k] = k === "announcement" ? { ...settings.announcement, ...body[k] } : body[k];
  if (keys.includes("platformFeePct")) settings.platformFeePct = clampFeePct(settings.platformFeePct, 0);
  if (keys.includes("bbRateMin") || keys.includes("bbRateMax")) {   // حدود نسب كرة السلة: الأدنى ≤ الأعلى
    const lo = clampN(settings.bbRateMin, 0, 50, 0.4);
    settings.bbRateMin = lo; settings.bbRateMax = Math.max(lo, clampN(settings.bbRateMax, 0.1, 100, 15));
  }
  await saveConfig({ settings });
  if (keys.includes("platformFeePct")) FEE_NOW = settings.platformFeePct / 100;
  LIVE_NOW = settings;
  await adminLog(`إعدادات: ${keys.join("، ")}`);
  return settings;
});
route("POST", "/api/admin/settings/reset", A, async () => {
  await saveConfig({ settings: clone(DEFAULT_SETTINGS) }); await adminLog("إعادة الإعدادات للافتراضي");
  return DEFAULT_SETTINGS;
});
route("GET", "/api/admin/log", A, async () => ((await (await C()).meta.findOne({ _id: "adminlog" }))?.items) || []);
route("GET", "/api/admin/users", A, async ({ cfg }) => {
  const { users } = await C();
  return (await users.find({}).sort({ balance: -1 }).limit(500).toArray()).map((u) => publicUser(u, cfg));
});
route("GET", "/api/admin/users/:id", A, async ({ params }) => {
  const u = await (await C()).users.findOne({ _id: Number(params.id) });
  if (!u) throw notFound("المستخدم غير موجود");
  return u;
});
route("PATCH", "/api/admin/users/:id", A, async ({ params, body, cfg }) => {
  const set = {};
  for (const k of ["name", "avatar", "frozen", "vipXp", "streak", "bestStreak", "lastBonusAt", "claimedCommission"]) if (body[k] !== undefined) set[k] = body[k];
  if (body.banned !== undefined) { set.banned = !!body.banned; set.bannedAt = body.banned ? Date.now() : null; }   // حظر/رفع حظر اللاعب من التطبيق
  if (body.balance !== undefined) { const v = Number(body.balance); if (!Number.isFinite(v) || v < 0) throw bad("رصيد غير صحيح"); set.balance = r2(v); }
  for (const k of ["dailyLossLimit", "maxStake", "selfExcludedUntil"]) if (body.limits && body.limits[k] !== undefined) set[`limits.${k}`] = body.limits[k];
  for (const k of ["enabled", "threshold", "amount", "method", "dailyCap", "depositedToday"]) if (body.autoDeposit && body.autoDeposit[k] !== undefined) set[`autoDeposit.${k}`] = body.autoDeposit[k];
  if (!Object.keys(set).length) throw bad("لا توجد حقول للتعديل");
  const u = await fau((await C()).users, { _id: Number(params.id) }, { $set: set });
  if (!u) throw notFound("المستخدم غير موجود");
  await adminLog(`تعديل المستخدم ${u._id}: ${Object.keys(set).join("، ")}`);
  return publicUser(u, cfg);
});
/* حذف اللاعب نهائياً: حسابه ورهاناته وحركاته وإحالاته. الرهانات المفتوحة تُسحب من المجمّعات أولاً.
 * ملاحظة: لو فتح التطبيق مجدداً يُنشأ له حساب جديد فارغ — لمنع عودته استعمل «الحظر» بدل الحذف. */
route("DELETE", "/api/admin/users/:id", A, async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw bad("معرّف غير صحيح");
  if (id === 0) throw bad("لا يمكن حذف حساب الضيف المشترك");
  const { users, bets, txs, refs, deposits, meta } = await C();
  const u = await users.findOne({ _id: id });
  if (!u) throw notFound("اللاعب غير موجود");
  for (const b of await bets.find({ userId: id, status: "open" }).toArray()) await refundBet(b, "حذف حساب").catch(() => undefined);
  await bets.deleteMany({ userId: id });
  await txs.deleteMany({ userId: id });
  await deposits.updateMany({ userId: id, status: "pending" }, { $set: { status: "expired" } });   // لا يُقبل تحويل لحساب محذوف
  await refs.deleteMany({ $or: [{ userId: id }, { inviterId: id }] });
  await users.updateMany({ referredBy: id }, { $set: { referredBy: null } });
  await meta.deleteOne({ _id: `pref:${id}` });
  await users.deleteOne({ _id: id });
  await adminLog(`حذف اللاعب نهائياً: ${id} (${u.name})`);
  return { ok: true };
});
route("POST", "/api/admin/users/:id/balance", A, async ({ params, body }) => {
  const delta = Number(body.delta);
  if (!Number.isFinite(delta)) throw bad("قيمة غير صحيحة");
  const id = Number(params.id);
  const { users, refs } = await C();
  const u = await fau(users, delta < 0 ? { _id: id, balance: { $gte: -delta } } : { _id: id }, { $inc: { balance: delta } });
  if (!u) throw bad("المستخدم غير موجود أو الرصيد لا يكفي");
  await addTx(id, { kind: delta >= 0 ? "bonus" : "adjust", amount: delta, label: body.note || "تعديل إداري للرصيد" });
  // تأهيل الإحالة: منح المدعو 5$ بالضبط من الإدارة (مرة واحدة) يفعّل احتساب عمولة صاحب الدعوة من هذه اللحظة
  if (delta === 5) {
    const q = await fau(refs, { userId: id, qualified: { $ne: true } }, { $set: { qualified: true, qualifiedAt: Date.now() } });
    if (q) {
      // مكافأة الإحالة (0.2$) لا تُمنح عند التسجيل، بل فقط الآن بعد أن استلم المدعو مكافأة الإدارة 5$ (مرة واحدة بفضل fau أعلاه)
      if (REF_JOIN_BONUS > 0 && users) {
        const inv = await credit(q.inviterId, REF_JOIN_BONUS);
        if (inv) await addTx(q.inviterId, { kind: "bonus", amount: REF_JOIN_BONUS, label: `مكافأة إحالة ${u.name}` });
      }
      await addNotice(q.inviterId, { title: "✅ إحالتك أصبحت مؤهَّلة", body: `${u.name} استلم مكافأة الإدارة، فحصلت على $${REF_JOIN_BONUS} وتُحتسب عمولتك على رهاناته من الآن.`, tone: "success" });
      await adminLog(`تأهيل إحالة: ${id} ← ${q.inviterId}`);
    }
  }
  await adminLog(`تعديل رصيد ${id} بمقدار ${delta}`);
  return { balance: r2(u.balance) };
});
route("POST", "/api/admin/broadcast", A, async ({ body }) => {
  if (!body?.title) throw bad("العنوان مطلوب");
  const { users } = await C();
  const n = { id: uid(), title: String(body.title), body: String(body.body || ""), tone: body.tone || "info", at: Date.now(), read: false };
  await users.updateMany({}, { $push: { notices: { $each: [n], $position: 0, $slice: 60 } } });
  await (await C()).meta.updateOne({ _id: "broadcasts" }, { $push: { items: { $each: [{ id: n.id, title: n.title, body: n.body, tone: n.tone, at: n.at }], $position: 0, $slice: 100 } } }, { upsert: true });
  await adminLog(`بث إشعار: ${body.title}`);
  return { ok: true };
});
async function findTx(id) {
  const { txs } = await C();
  const tx = await txs.findOne({ _id: id });
  if (!tx) throw notFound("الحركة غير موجودة");
  return tx;
}
route("POST", "/api/admin/transactions/:id/approve", A, async ({ params }) => {
  const tx = await findTx(params.id);
  const out = await fau((await C()).txs, { _id: tx._id }, { $set: { status: "done" } });
  await adminLog(`اعتماد حركة ${tx._id}`);
  return pub(out, true);
});
route("POST", "/api/admin/transactions/:id/reject", A, async ({ params }) => {
  const tx = await findTx(params.id);
  const { txs } = await C();
  const claimed = await fau(txs, { _id: tx._id, status: "pending" }, { $set: { status: "rejected" } });
  if (!claimed) throw bad("لا يمكن رفض هذه الحركة");
  if (tx.kind === "withdraw") await credit(tx.userId, Math.abs(tx.amount));
  await adminLog(`رفض حركة ${tx._id}`);
  return pub(claimed, true);
});
route("GET", "/api/admin/withdrawals", A, async () => {
  const { txs } = await C();
  return (await txs.find({ kind: "withdraw", status: "pending" }).sort({ at: -1 }).limit(200).toArray()).map((t) => pub(t, true));
});

/* ============================ الإيداع التلقائي — USDT TRC-20 ============================
 * كل طلب يحصل على «مبلغ فريد» (مثل 50.47) فيتعرّف الخادم على صاحب التحويل من المبلغ نفسه.
 * بما أن Vercel لا يشغّل مهاماً خلفية، يتحقق الخادم من TronGrid عند كل استعلام عن الطلب
 * (مع قفل يمنع أكثر من فحص كل 4 ثوانٍ)، وبشكل اختياري عبر Cron: GET /api/cron/deposits
 * الاعتماد ذرّي: الطلب يُحجز مرة واحدة + TXID فريد + إضافة الرصيد idempotent (لا تكرار حتى عند الانقطاع). */
const DEP = {
  address: process.env.TRC20_ADDRESS || "TZG3etXFT2k9hV3ZFxwUGEj9KQXXfdjDuV",
  contract: process.env.USDT_TRC20_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  tronApi: (process.env.TRONGRID_URL || "https://api.trongrid.io").replace(/\/$/, ""),
  tronKey: process.env.TRONGRID_API_KEY || "",
  ttlMs: (Number(process.env.DEPOSIT_TTL_MIN) || 30) * 60_000,
  graceMs: 10 * 60_000, // نقبل تحويلاً وصل متأخراً قليلاً بعد انتهاء المهلة
};
const depUnits = (u) => (u / 1_000_000).toFixed(2);
const depView = (o) => ({
  id: o._id, method: "trc20", baseAmount: o.baseAmount, payAmount: depUnits(o.units || o.creditedUnits),
  status: o.status === "pending" && Date.now() > o.expiresAt ? "expired" : o.status,
  creditedAmount: o.creditedUnits ? depUnits(o.creditedUnits) : null,
  createdAt: o.createdAt, expiresAt: o.expiresAt, txid: o.txid || null,
});
/** الإيداع يتطلب مستخدم تيليجرام موثَّقاً (التوقيع) — لا ضيوف ولا x-user-id مزوَّر */
function depositUser(ctx) {
  const viaTelegram = !!(BOT_TOKEN && ctx.req.headers["x-telegram-init-data"]);
  if (!viaTelegram && process.env.DEPOSIT_ALLOW_GUESTS !== "true") throw new HttpError(401, "الإيداع يتطلب الدخول عبر تيليجرام");
  if (!ctx.user?._id) throw new HttpError(401, "الإيداع يتطلب حساباً حقيقياً");
  return ctx.user;
}
/** تحويلات USDT المؤكَّدة الواردة لعنوانك منذ وقت معيّن (TronGrid) */
async function fetchTrc20(sinceMs) {
  const out = [];
  let fingerprint = "";
  for (let page = 0; page < 5; page++) {
    const url = `${DEP.tronApi}/v1/accounts/${DEP.address}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&order_by=block_timestamp,asc&min_timestamp=${Math.floor(sinceMs)}&contract_address=${DEP.contract}${fingerprint ? `&fingerprint=${encodeURIComponent(fingerprint)}` : ""}`;
    const r = await fetch(url, { headers: DEP.tronKey ? { "TRON-PRO-API-KEY": DEP.tronKey } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`TronGrid ${r.status}`);
    const j = await r.json();
    for (const t of j.data || []) {
      if (t.type !== "Transfer" || t.to !== DEP.address) continue;
      if (t.token_info?.address !== DEP.contract || Number(t.token_info.decimals) !== 6) continue;
      out.push({ txid: t.transaction_id, units: Number(t.value), at: t.block_timestamp, from: t.from });
    }
    fingerprint = j.meta?.fingerprint || "";
    if (!fingerprint) break;
  }
  return out;
}
/** إضافة الرصيد — idempotent: الشرط depositIds يمنع الإضافة مرتين مهما تكرّر الاستدعاء */
async function finishCredit(o) {
  const { users, deposits } = await C();
  const amount = r2(o.creditedUnits / 1_000_000);
  const r = await users.updateOne({ _id: o.userId, depositIds: { $ne: o._id } }, { $inc: { balance: amount }, $push: { depositIds: o._id } });
  if (r.modifiedCount === 1) {
    await addTx(o.userId, { kind: "deposit", amount, label: "إيداع عبر USDT TRC-20", method: "usdt", txid: o.txid });
    await addNotice(o.userId, { title: "✅ تم الإيداع", body: `وصل $${amount} عبر USDT TRC-20 وأُضيف إلى رصيدك.`, tone: "success" });
  }
  await deposits.updateOne({ _id: o._id }, { $set: { balanceCredited: true } });
}
async function creditDeposit(order, tx) {
  const { deposits } = await C();
  let claimed;
  try {
    claimed = await fau(deposits, { _id: order._id, status: "pending" }, { $set: { status: "credited", txid: tx.txid, creditedUnits: tx.units, creditedAt: Date.now(), acked: false, balanceCredited: false, from: tx.from } });
  } catch (e) { if (e?.code === 11000) return false; throw e; }   // TXID مستخدم من قبل
  if (!claimed) return false;
  await finishCredit(claimed);
  return true;
}
/** يطابق التحويلات الواردة مع الطلبات المعلّقة ويعتمدها (آمن للاستدعاء المتكرر والمتزامن) */
async function scanDeposits({ force = false } = {}) {
  const { deposits, meta } = await C();
  const now = Date.now();
  await deposits.updateMany({ status: "pending", liveUntil: { $lt: now } }, { $set: { status: "expired" } });
  // تعافٍ: طلبات اعتُمدت لكن لم يكتمل إضافة رصيدها (انقطاع وسط العملية)
  const stuck = await deposits.find({ status: "credited", balanceCredited: { $ne: true }, creditedAt: { $lt: now - 20_000 } }).limit(20).toArray();
  for (const o of stuck) await finishCredit(o).catch((e) => console.error("finishCredit:", e));
  const live = await deposits.find({ status: "pending" }).toArray();
  if (!live.length) return 0;
  if (!force) {   // قفل: فحص واحد كل 4 ثوانٍ على مستوى كل النسخ
    try { await meta.updateOne({ _id: "depscan", at: { $lt: now - 4000 } }, { $set: { at: now } }, { upsert: true }); }
    catch (e) { if (e?.code === 11000) return 0; throw e; }
  }
  const txs = await fetchTrc20(Math.min(...live.map((o) => o.createdAt)) - 60_000);
  let n = 0;
  for (const o of live) {
    const tx = txs.find((t) => t.units === o.units && t.at >= o.createdAt - 60_000 && t.at <= o.liveUntil);
    if (tx && (await creditDeposit(o, tx))) n++;
  }
  return n;
}
const safeScan = (opts) => scanDeposits(opts).catch((e) => { console.error("scanDeposits:", e.message); return 0; });

route("GET", "/api/deposit/config", { auth: false, sync: false }, ({ cfg }) => ({
  methods: { trc20: true }, trc20Address: DEP.address, minDeposit: cfg.settings.minDeposit, maxDeposit: cfg.settings.maxDeposit, ttlMin: Math.round(DEP.ttlMs / 60_000),
}));
route("POST", "/api/deposit/orders", { sync: false }, async (ctx) => {
  const user = depositUser(ctx), { body, cfg } = ctx;
  assertActive(user, cfg);
  if (!cfg.settings.depositsEnabled) throw forbid("الإيداع متوقف حالياً");
  if (body.method && body.method !== "trc20") throw bad("طريقة الإيداع المتاحة: USDT TRC-20 فقط");
  const base = Math.floor(Number(body.amount) * 100) / 100;
  const dMin = Number(cfg.settings.minDeposit) || 0, dMax = Number(cfg.settings.maxDeposit) || 0; // من إعدادات الأدمن (0 = بلا حد أقصى)
  if (!Number.isFinite(base) || base <= 0 || base < dMin || (dMax > 0 && base > dMax)) throw bad(`المبلغ يجب أن يكون ${dMax > 0 ? `بين $${dMin} و $${dMax}` : `$${dMin} على الأقل`}`);
  const { deposits } = await C();
  const now = Date.now();
  await deposits.updateMany({ status: "pending", liveUntil: { $lt: now } }, { $set: { status: "expired" } });
  if (await deposits.countDocuments({ userId: user._id, status: "pending" }) >= 3) throw new HttpError(429, "لديك 3 طلبات معلّقة — أكملها أو انتظر انتهاءها");
  for (let i = 0; i < 40; i++) {   // مبلغ فريد: +0.01…0.99 — الفهرس الفريد يمنع التكرار حتى مع التزامن
    const units = Math.round(base * 100) * 10_000 + (1 + Math.floor(Math.random() * 99)) * 10_000;
    const doc = { _id: uid(), userId: user._id, method: "trc20", baseAmount: base, units, status: "pending", createdAt: now, expiresAt: now + DEP.ttlMs, liveUntil: now + DEP.ttlMs + DEP.graceMs, acked: false };
    try { await deposits.insertOne(doc); return { order: depView(doc) }; }
    catch (e) { if (e?.code !== 11000) throw e; }
  }
  throw new HttpError(503, "ازدحام — حاول بعد قليل");
});
route("GET", "/api/deposit/orders/:id", { sync: false }, async (ctx) => {
  const user = depositUser(ctx);
  const { deposits } = await C();
  let o = await deposits.findOne({ _id: ctx.params.id, userId: user._id });
  if (!o) throw notFound("الطلب غير موجود");
  if (o.status === "pending") { await safeScan(); o = await deposits.findOne({ _id: o._id }); }
  return { order: depView(o) };
});
route("GET", "/api/deposit/pending", { sync: false }, async (ctx) => {
  const user = depositUser(ctx);
  const { deposits } = await C();
  if (await deposits.countDocuments({ userId: user._id, status: "pending" })) await safeScan();
  const list = await deposits.find({ userId: user._id, status: "credited", acked: { $ne: true } }).limit(50).toArray();
  return { deposits: list.map(depView) };
});
route("POST", "/api/deposit/ack", { sync: false }, async (ctx) => {
  const user = depositUser(ctx);
  const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids.slice(0, 50).map(String) : [];
  const { deposits } = await C();
  const r = await deposits.updateMany({ _id: { $in: ids }, userId: user._id, status: "credited" }, { $set: { acked: true } });
  return { acked: r.modifiedCount };
});
/* Cron اختياري (Vercel Cron يرسل Authorization: Bearer CRON_SECRET) — يلتقط الإيداعات حتى لو أغلق المستخدم التطبيق */
route("GET", "/api/cron/deposits", { auth: false, sync: false }, async ({ req }) => {
  const sec = process.env.CRON_SECRET;
  if (!sec || req.headers.authorization !== `Bearer ${sec}`) throw new HttpError(401, "غير مصرّح");
  return { ok: true, credited: await scanDeposits({ force: true }) };
});
/* إدارة: كل الطلبات + التحويلات غير المطابقة (مبلغ خاطئ) + اعتماد يدوي */
route("GET", "/api/admin/deposits", A, async ({ query }) => {
  const { deposits } = await C();
  const f = query.userId ? { userId: Number(query.userId) } : {}; // ?userId= لعرض إيداعات لاعب واحد
  return (await deposits.find(f).sort({ createdAt: -1 }).limit(200).toArray()).map((o) => ({ ...depView(o), userId: o.userId, balanceCredited: !!o.balanceCredited }));
});
route("GET", "/api/admin/deposits/unmatched", A, async () => {
  const { deposits } = await C();
  const txs = await fetchTrc20(Date.now() - 48 * 3600_000);
  const used = new Set((await deposits.find({ txid: { $in: txs.map((t) => t.txid) } }, { projection: { txid: 1 } }).toArray()).map((d) => d.txid));
  return txs.filter((t) => !used.has(t.txid) && t.units >= 1_000_000).map((t) => ({ txid: t.txid, amount: depUnits(t.units), at: t.at, from: t.from }));
});
route("POST", "/api/admin/deposits/credit", A, async ({ body }) => {
  const userId = Number(body?.userId), txid = String(body?.txid || "");
  if (!Number.isInteger(userId) || !txid) throw bad("userId و txid مطلوبان");
  const { users, deposits } = await C();
  if (!(await users.findOne({ _id: userId }))) throw notFound("المستخدم غير موجود");
  const tx = (await fetchTrc20(Date.now() - 7 * 24 * 3600_000)).find((t) => t.txid === txid);
  if (!tx) throw notFound("التحويل غير موجود أو غير مؤكَّد على عنوانك (آخر 7 أيام)");
  const doc = { _id: uid(), userId, method: "trc20", baseAmount: tx.units / 1_000_000, status: "credited", txid, creditedUnits: tx.units, createdAt: Date.now(), expiresAt: Date.now(), creditedAt: Date.now(), acked: false, balanceCredited: false, manual: true };
  try { await deposits.insertOne(doc); } catch (e) { if (e?.code === 11000) throw bad("هذا التحويل أُضيف من قبل"); throw e; }
  await finishCredit(doc);
  await adminLog(`اعتماد يدوي لإيداع ${txid} (${depUnits(tx.units)}$) للمستخدم ${userId}`);
  return { ok: true, amount: depUnits(tx.units) };
});

/* مباريات (إدارة) */
/* رابط صورة (شعار فريق/دوري): http(s) فقط وبطول معقول، وإلا يُهمَل — لمنع javascript: وما شابه */
const cleanLogo = (u) => { const v = typeof u === "string" ? u.trim() : ""; return /^https?:\/\/\S{3,500}$/i.test(v) ? v : ""; };
const cleanTeam = (t) => (t && typeof t === "object" ? { ...t, logo: cleanLogo(t.logo) } : t);
route("POST", "/api/admin/matches", A, async ({ body }) => {
  for (const k of ["leagueId", "home", "away"]) if (!body?.[k]) throw bad(`الحقل ${k} مطلوب`);
  const id = `m${Date.now().toString(36)}`;
  const team = (t) => (typeof t === "string" ? { name: t, short: t.slice(0, 3).toUpperCase(), colors: ["#1a6ef0", "#0b3a8f"] } : cleanTeam(t));
  const startsAt = body.startsAt ? Number(body.startsAt) : Date.now() + (Number(body.inMinutes) || 60) * 60000;
  const live = !!body.live, minute = live ? Math.min(89, Math.max(1, Number(body.minute) || 1)) : 0;
  const bias = Math.min(2, Math.max(0.5, Number(body.bias) || 1.05));
  const tpl = buildMatch({ league: body.leagueId, home: team(body.home), away: team(body.away), inMinutes: live ? -1 : 60, bias, hot: !!body.hot, boosted: !!body.boosted }, 0);
  const nm = { ...tpl, id, leagueId: body.leagueId, home: team(body.home), away: team(body.away), startsAt: live ? Date.now() - minute * 60000 : startsAt, status: live ? "live" : "upcoming", minute, score: [0, 0], hot: !!body.hot, boosted: !!body.boosted };
  if (body.feePct !== undefined && body.feePct !== null && body.feePct !== "") nm.feePct = clampFeePct(body.feePct); // نسبة خاصة بهذه المباراة (وإلا تُستعمل العامة)
  await mutateState((ms) => [...ms, nm]);
  await adminLog(`إضافة مباراة ${id}`);
  return matchView(nm);
});
route("PATCH", "/api/admin/matches/:id", A, async ({ params, body }) => {
  const allowed = ["hot", "boosted", "suspended", "frozen", "startsAt", "leagueId", "home", "away", "minute", "score", "status", "feePct"];
  let out;
  await mutateState((ms) => {
    if (!findMatch(ms, params.id)) throw notFound("المباراة غير موجودة");
    return ms.map((m) => {
      if (m.id !== params.id) return m;
      const n = { ...m }; for (const k of allowed) if (body[k] !== undefined) n[k] = k === "home" || k === "away" ? cleanTeam(body[k]) : k === "feePct" ? (body[k] === null || body[k] === "" ? null : clampFeePct(body[k])) : body[k];
      return (out = n);
    });
  });
  await adminLog(`تعديل المباراة ${params.id}`);
  return matchView(out);
});
route("DELETE", "/api/admin/matches/:id", A, async ({ params }) => {
  const { bets } = await C();
  const open = await bets.find({ matchId: params.id, status: "open" }).toArray();
  for (const b of open) await refundBet(b, "إلغاء مباراة");
  await mutateState((ms) => {
    if (!findMatch(ms, params.id)) throw notFound("المباراة غير موجودة");
    return ms.filter((m) => m.id !== params.id);
  });
  await adminLog(`حذف المباراة ${params.id}`);
  return { ok: true, refunded: open.length };
});
route("POST", "/api/admin/matches/:id/goal", A, async ({ params, body }) => {
  const side = body?.side === "away" ? 1 : 0;
  let out;
  await mutateState((ms) => {
    if (!findMatch(ms, params.id)) throw notFound("المباراة غير موجودة");
    return ms.map((m) => {
      if (m.id !== params.id) return m;
      const score = [...m.score]; score[side] += 1;
      return (out = { ...m, score });
    });
  });
  await adminLog(`هدف يدوي في ${params.id}`);
  return matchView(out);
});
route("POST", "/api/admin/matches/:id/start", A, async ({ params }) => {
  let out;
  await mutateState((ms) => {
    if (!findMatch(ms, params.id)) throw notFound("المباراة غير موجودة");
    return ms.map((m) => (m.id === params.id ? (out = { ...m, status: "live", minute: Math.max(1, m.minute), startsAt: Math.min(m.startsAt, Date.now()) }) : m));
  });
  await adminLog(`بدء المباراة ${params.id}`);
  return matchView(out);
});
route("POST", "/api/admin/matches/:id/end", A, async ({ params, body }) => {
  let out;
  const ms = await mutateState((arr) => {
    if (!findMatch(arr, params.id)) throw notFound("المباراة غير موجودة");
    return arr.map((m) => (m.id === params.id ? (out = {
      ...m, status: "ended", minute: 90, endedAt: Date.now(),
      score: Number.isInteger(body?.home) && Number.isInteger(body?.away) ? [body.home, body.away] : m.score,
    }) : m));
  });
  const ev = await settleBets(new Set([params.id]), ms);
  await adminLog(`إنهاء المباراة ${params.id}`);
  return { match: matchView(out), settled: ev.length };
});
route("POST", "/api/admin/matches/reset", A, async () => {
  await mutateState(() => buildMatches()); await adminLog("إعادة المباريات للافتراضي");
  return { ok: true };
});

/* كتالوجات (إدارة) */
async function editList(key, fn, msg) {
  const cfg = await getConfig(true);
  const list = fn(clone(cfg[key]));
  await saveConfig({ [key]: list });
  await adminLog(msg);
  return list;
}
route("PUT", "/api/admin/payments/:id", A, async ({ params, body }) => {
  let out; await editList("payments", (l) => { const p = l.find((x) => x.id === params.id); if (!p) throw notFound("طريقة الدفع غير موجودة"); Object.assign(p, body, { id: p.id }); out = p; return l; }, `تعديل طريقة الدفع ${params.id}`);
  return out;
});
route("POST", "/api/admin/payments", A, async ({ body }) => {
  if (!body?.name) throw bad("الاسم مطلوب");
  const p = { id: uid(), emoji: "💰", note: "", minDeposit: 5, maxDeposit: 1000, feePct: 0, eta: "دقائق", enabled: true, ...body };
  await editList("payments", (l) => [...l, p], `إضافة طريقة دفع ${p.name}`);
  return p;
});
route("DELETE", "/api/admin/payments/:id", A, async ({ params }) => {
  await editList("payments", (l) => { if (l.length <= 1) throw bad("يجب إبقاء طريقة دفع واحدة على الأقل"); return l.filter((p) => p.id !== params.id); }, `حذف طريقة الدفع ${params.id}`);
  return { ok: true };
});
route("PUT", "/api/admin/leagues/:id", A, async ({ params, body }) => {
  let out; await editList("leagues", (l) => { const x = l.find((y) => y.id === params.id); if (!x) throw notFound("الدوري غير موجود"); Object.assign(x, body, { id: x.id }); if ("logo" in body) x.logo = cleanLogo(body.logo); out = x; return l; }, `تعديل الدوري ${params.id}`);
  return out;
});
route("POST", "/api/admin/leagues", A, async ({ body }) => {
  if (!body?.name) throw bad("الاسم مطلوب");
  const l = { id: uid(), flag: "🏳️", country: "", hue: 150, ...body, logo: cleanLogo(body.logo) };
  await editList("leagues", (arr) => [...arr, l], `إضافة دوري ${l.name}`);
  return l;
});
route("DELETE", "/api/admin/leagues/:id", A, async ({ params }) => {
  await editList("leagues", (l) => { if (l.length <= 1) throw bad("يجب إبقاء دوري واحد على الأقل"); return l.filter((x) => x.id !== params.id); }, `حذف الدوري ${params.id}`);
  return { ok: true };
});
route("PUT", "/api/admin/vip/:index", A, async ({ params, body }) => {
  let out; await editList("vipTiers", (l) => { const t = l[Number(params.index)]; if (!t) throw notFound("المستوى غير موجود"); Object.assign(t, body, { key: t.key }); out = t; return l; }, `تعديل مستوى VIP ${Number(params.index) + 1}`);
  return out;
});


/* ============================ مسارات إضافية لوحة الأدمن (الرهانات · الحركات · المجمّعات · الإشعارات …) ============================ */
route("GET", "/api/admin/pin-status", A, async () => {
  const doc = await (await C()).meta.findOne({ _id: "adminpin" });
  return { custom: !!doc?.hash, usingDefault: !doc?.hash && ADMIN_PIN === "123456" };
});
route("PUT", "/api/admin/pin", A, async ({ body }) => {
  if (!(await pinOk(body?.oldPin))) throw new HttpError(401, "الرمز الحالي غير صحيح");
  const np = String(body?.newPin ?? "");
  if (!/^\d{4,12}$/.test(np)) throw bad("الرمز الجديد يجب أن يكون 4–12 رقماً");
  const salt = crypto.randomBytes(16).toString("hex");
  await (await C()).meta.updateOne({ _id: "adminpin" }, { $set: { salt, hash: pinHash(np, salt) } }, { upsert: true });
  await adminLog("تغيير رمز الدخول");
  return { ok: true };
});
route("DELETE", "/api/admin/log", A, async () => {
  await (await C()).meta.updateOne({ _id: "adminlog" }, { $set: { items: [] } }, { upsert: true });
  return { ok: true };
});

/* ---- رهانات ---- */
route("GET", "/api/admin/bets", A, async ({ query }) => {
  const { bets } = await C();
  const f = {};
  if (query.status) f.status = query.status;
  if (query.userId) f.userId = Number(query.userId);
  return (await bets.find(f).sort({ createdAt: -1 }).limit(Math.min(Number(query.limit) || 1000, 5000)).toArray()).map((b) => pub(b, true));
});
/* ---- تعويض خاسري مباراة: إعادة مبلغ رهانات الخاسرين (كلياً أو بنسبة) لمرة واحدة لكل رهان ---- */
const lostFilter = (matchId, src) => {
  const f = { matchId, status: "lost", compensated: { $ne: true } };
  if (src?.pick) { f.pick = String(src.pick); f.market = src.market === "result" ? "result" : "exact"; }   // تعويض نتيجة واحدة فقط
  return f;
};
route("GET", "/api/admin/matches/:id/compensation", A, async ({ params, query }) => {
  const { bets } = await C();
  const list = await bets.find(lostFilter(params.id, query)).toArray();
  return { count: list.length, players: new Set(list.map((b) => b.userId)).size, totalStake: r2(list.reduce((a, b) => a + b.stake, 0)) };
});
route("POST", "/api/admin/matches/:id/compensate", A, async ({ params, body }) => {
  const percent = Math.min(100, Math.max(1, Number(body?.percent) || 100));
  const { bets } = await C();
  const list = await bets.find(lostFilter(params.id, body)).toArray();
  let count = 0, total = 0;
  const players = new Set();
  for (const b of list) {
    const amount = r2(Math.min(b.stake, (b.stake * percent) / 100));   // التعويض = مبلغ الرهان فقط (أو نسبة منه) — بدون أرباح ولا مضاعف أودز
    const claimed = await fau(bets, { _id: b._id, status: "lost", compensated: { $ne: true } }, { $set: { compensated: true, compensatedAmount: amount, compensatedAt: Date.now(), payout: amount } });
    if (!claimed) continue; // عُوِّض بالفعل (حماية من الضغط المزدوج)
    await credit(b.userId, amount);
    await addTx(b.userId, { kind: "refund", amount, label: `تعويض خسارة ${b.matchLabel}` });
    await addNotice(b.userId, { title: "🎁 تعويض خسارة", body: `تم تعويضك $${amount} عن رهانك في ${b.matchLabel}.`, tone: "gold" });
    count++; total += amount; players.add(b.userId);
  }
  await adminLog(`تعويض خاسري المباراة ${params.id}${body?.pick ? ` (نتيجة ${body.pick})` : ""}: ${count} رهان · $${r2(total)} · ${percent}%`);
  return { ok: true, compensated: count, players: players.size, total: r2(total) };
});
route("POST", "/api/admin/bets/:id/settle", A, async ({ params, body }) => {
  const { bets, users } = await C();
  const b = await bets.findOne({ _id: params.id });
  if (!b) throw notFound("الرهان غير موجود");
  if (b.status !== "open") throw bad("الرهان مسوّى بالفعل");
  const u = await users.findOne({ _id: b.userId });
  if (body?.result === "refund") {
    if (!(await refundBet(b, "استرداد إداري"))) throw bad("تعذّر الاسترداد");
  } else if (body?.result === "won") {
    const payout = payoutOf(b.stake, b.odds, streakBonus(u?.streak || 0));
    const claimed = await fau(bets, { _id: b._id, status: "open" }, { $set: { status: "won", payout, settledAt: Date.now() } });
    if (!claimed) throw bad("الرهان مسوّى بالفعل");
    await users.updateOne({ _id: b.userId }, { $inc: { balance: payout, streak: 1, vipXp: Math.round(b.stake) }, $set: { bestStreak: Math.max(u?.bestStreak || 0, (u?.streak || 0) + 1) } });
    await addTx(b.userId, { kind: "win", amount: payout, label: `فوز ${b.matchLabel} — ${b.pick}` });
    await addNotice(b.userId, { title: `🏆 فزت $${payout}!`, body: `${b.matchLabel} — توقّعك ${b.pick} أصاب!`, tone: "success" });
  } else if (body?.result === "lost") {
    const claimed = await fau(bets, { _id: b._id, status: "open" }, { $set: { status: "lost", payout: 0, settledAt: Date.now() } });
    if (!claimed) throw bad("الرهان مسوّى بالفعل");
    await users.updateOne({ _id: b.userId }, { $set: { streak: 0 } });
    await addNotice(b.userId, { title: "انتهى الرهان", body: `${b.matchLabel} — حظاً أوفر في القادمة.`, tone: "alert" });
  } else throw bad("نتيجة غير صالحة (won | lost | refund)");
  await adminLog(`تسوية يدوية للرهان ${b._id}: ${body.result}`);
  return pub(await bets.findOne({ _id: b._id }), true);
});
route("DELETE", "/api/admin/bets/:id", A, async ({ params, query }) => {
  const { bets } = await C();
  const b = await bets.findOne({ _id: params.id });
  if (!b) throw notFound("الرهان غير موجود");
  if (query.refund === "1" && b.status === "open") await refundBet(b, "حذف رهان");
  await bets.deleteOne({ _id: b._id });
  await adminLog(`حذف رهان ${b._id}${query.refund === "1" ? " مع استرداد" : ""}`);
  return { ok: true };
});
route("POST", "/api/admin/bets/refund-open", A, async () => {
  const { bets } = await C();
  const open = await bets.find({ status: "open" }).toArray();
  let n = 0;
  for (const b of open) if (await refundBet(b, "استرداد إداري")) n++;
  await adminLog(`استرداد ${n} رهان مفتوح`);
  return { ok: true, refunded: n };
});
route("POST", "/api/admin/bets/clear", A, async () => {
  const r = await (await C()).bets.deleteMany({ status: { $ne: "open" } });
  await adminLog("مسح سجل الرهانات المسوّاة");
  return { ok: true, deleted: r.deletedCount };
});

/* ---- حركات مالية ---- */
route("GET", "/api/admin/transactions", A, async ({ query }) => {
  const { txs } = await C();
  const f = {};
  if (query.kind) f.kind = query.kind;
  if (query.status) f.status = query.status;
  if (query.userId) f.userId = Number(query.userId);
  return (await txs.find(f).sort({ at: -1 }).limit(Math.min(Number(query.limit) || 500, 2000)).toArray()).map((t) => pub(t, true));
});
route("POST", "/api/admin/transactions", A, async ({ body }) => {
  const id = Number(body?.userId), amount = Number(body?.amount);
  const KINDS = ["deposit", "withdraw", "bet", "win", "refund", "cashout", "bonus", "commission", "adjust"];
  if (!Number.isInteger(id) || !Number.isFinite(amount) || !KINDS.includes(body?.kind)) throw bad("بيانات الحركة غير صحيحة");
  const { users } = await C();
  if (!(await users.findOne({ _id: id }))) throw notFound("المستخدم غير موجود");
  if (body.applyToBalance) {
    const u = await fau(users, amount < 0 ? { _id: id, balance: { $gte: -amount } } : { _id: id }, { $inc: { balance: amount } });
    if (!u) throw bad("الرصيد لا يكفي");
  }
  const tx = await addTx(id, { kind: body.kind, amount, label: String(body.label || "حركة يدوية"), manual: true });
  await adminLog(`إضافة حركة ${body.kind} ${amount} للمستخدم ${id}${body.applyToBalance ? " (مع الرصيد)" : ""}`);
  return pub(tx, true);
});
route("POST", "/api/admin/transactions/clear", A, async () => {
  const r = await (await C()).txs.deleteMany({ status: { $ne: "pending" } });
  await adminLog("مسح سجل الحركات (عدا المعلّقة)");
  return { ok: true, deleted: r.deletedCount };
});
route("DELETE", "/api/admin/transactions/:id", A, async ({ params }) => {
  const r = await (await C()).txs.deleteOne({ _id: params.id });
  if (!r.deletedCount) throw notFound("الحركة غير موجودة");
  await adminLog(`حذف حركة ${params.id}`);
  return { ok: true };
});

/* ---- لاعبون: إعادة ضبط + إحالات ---- */
route("POST", "/api/admin/users/:id/reset", A, async ({ params }) => {
  const id = Number(params.id);
  const { users, bets, txs } = await C();
  const r = await users.updateOne({ _id: id }, { $set: {
    balance: START_BALANCE, vipXp: 0, streak: 0, bestStreak: 0, lastBonusAt: 0, claimedCommission: 0, frozen: false, notices: [],
    limits: { dailyLossLimit: 0, maxStake: 0, selfExcludedUntil: null },
    autoDeposit: { enabled: false, threshold: 20, amount: 50, method: "ton", dailyCap: 200, depositedToday: 0, capDate: todayKey() },
  } });
  if (!r.matchedCount) throw notFound("المستخدم غير موجود");
  await bets.deleteMany({ userId: id }); await txs.deleteMany({ userId: id });
  await adminLog(`إعادة ضبط بيانات المستخدم ${id}`);
  return { ok: true };
});
route("GET", "/api/admin/users/:id/referrals", A, async ({ params }) => refsOf(Number(params.id)));
route("POST", "/api/admin/users/:id/referrals", A, async ({ params, body }) => {
  if (!body?.name) throw bad("الاسم مطلوب");
  const { refs } = await C();
  const doc = { _id: `r${uid()}`, inviterId: Number(params.id), userId: -Math.floor(1 + Math.random() * 1e9), name: String(body.name), avatar: body.avatar || "🎯", joinedAt: Date.now(), wagered: Number(body.wagered) || 0, commissionEarned: Number(body.commissionEarned) || 0, active: true, qualified: true };
  await refs.insertOne(doc);
  await adminLog(`إضافة إحالة ${doc.name} للمستخدم ${params.id}`);
  const { _id, inviterId, ...rest } = doc; return { id: _id, ...rest };
});
route("PATCH", "/api/admin/referrals/:id", A, async ({ params, body }) => {
  const set = {};
  for (const k of ["name", "avatar", "wagered", "commissionEarned", "active", "qualified"]) if (body[k] !== undefined) set[k] = body[k];
  const r = await fau((await C()).refs, { _id: params.id }, { $set: set });
  if (!r) throw notFound("الإحالة غير موجودة");
  await adminLog(`تعديل إحالة ${params.id}`);
  const { _id, inviterId, ...rest } = r; return { id: _id, ...rest };
});
route("DELETE", "/api/admin/referrals/:id", A, async ({ params }) => {
  const r = await (await C()).refs.deleteOne({ _id: params.id });
  if (!r.deletedCount) throw notFound("الإحالة غير موجودة");
  await adminLog(`حذف إحالة ${params.id}`);
  return { ok: true };
});

/* ---- إشعارات مبثوثة ---- */
route("GET", "/api/admin/broadcasts", A, async () => ((await (await C()).meta.findOne({ _id: "broadcasts" }))?.items) || []);
route("POST", "/api/admin/broadcasts/clear", A, async () => {
  const { users, meta } = await C();
  const ids = (((await meta.findOne({ _id: "broadcasts" }))?.items) || []).map((x) => x.id);
  if (ids.length) await users.updateMany({}, { $pull: { notices: { id: { $in: ids } } } });
  await meta.updateOne({ _id: "broadcasts" }, { $set: { items: [] } }, { upsert: true });
  await adminLog("مسح الإشعارات المبثوثة");
  return { ok: true };
});
route("DELETE", "/api/admin/broadcasts/:id", A, async ({ params }) => {
  const { users, meta } = await C();
  await users.updateMany({}, { $pull: { notices: { id: params.id } } });
  await meta.updateOne({ _id: "broadcasts" }, { $pull: { items: { id: params.id } } });
  await adminLog(`حذف إشعار مبثوث ${params.id}`);
  return { ok: true };
});

/* ---- مباريات: مجمّعات + عمليات جماعية + تقديم الوقت ---- */
route("PUT", "/api/admin/matches/:id/pools", A, async ({ params, body }) => {
  let out;
  await mutateState((ms) => {
    const m = findMatch(ms, params.id);
    if (!m) throw notFound("المباراة غير موجودة");
    /* ضبط النسب المئوية مباشرةً: market = exact (17 خياراً) أو result (3 خيارات) — تُعاد موازنة المجمّع مع الإبقاء على إجماليه */
    if (Array.isArray(body?.chances)) {
      const result = body.market === "result", n = result ? 3 : OPT_COUNT;
      const ch = body.chances.map((v) => Math.max(0, Number(v) || 0));
      const sum = ch.reduce((a, b) => a + b, 0);
      if (ch.length !== n || !(sum > 0)) throw bad("نسب غير صالحة");
      const total = Math.max(n * 10, totalPool(result ? rPoolsOf(m) : m.pools));
      const np = ch.map((v) => Math.max(1, +((v / sum) * total).toFixed(2)));
      return ms.map((x) => (x.id === m.id ? (out = result ? { ...x, rPools: np, manualPrices: true } : { ...withOdds(x, np), manualPrices: true }) : x));
    }
    /* ضبط نسب الربح ٪ مباشرةً لسوق: market = exact (17) أو result (3) — كل قيمة بين الحد الأدنى والأعلى */
    if (Array.isArray(body?.rates)) {
      const result = body.market === "result", n = result ? 3 : OPT_COUNT, { lo, hi } = rateBounds();
      if (body.rates.length !== n || body.rates.some((v) => !Number.isFinite(Number(v)))) throw bad("نسب غير صالحة");
      const rates = body.rates.map((v) => +clampN(v, lo, hi, hi).toFixed(2));
      return ms.map((x) => (x.id === m.id ? (out = { ...x, manualRates: { ...(x.manualRates || {}), [result ? "res" : "exact"]: rates } }) : x));
    }
    if (body?.auto) return ms.map((x) => (x.id === m.id ? (out = { ...x, manualRates: null, manualPrices: false }) : x));   // عودة للتسعير التلقائي
    let pools = m.pools.slice();
    if (body?.reset) pools = seedPools(1.05);
    else if (body?.scale !== undefined) { const f = Math.min(10, Math.max(0.1, Number(body.scale) || 1)); pools = pools.map((p) => Math.max(1, +(p * f).toFixed(2))); }
    else {
      const i = Number(body?.index);
      if (!Number.isInteger(i) || i < 0 || i >= OPT_COUNT) throw bad("خيار غير صالح");
      pools[i] = body.value !== undefined ? Math.max(1, Number(body.value) || 1) : Math.max(1, pools[i] + (Number(body.delta) || 0));
    }
    return ms.map((x) => (x.id === m.id ? (out = withOdds(x, pools)) : x));
  });
  await adminLog(`تعديل مجمّعات المباراة ${params.id}`);
  return matchView(out);
});
/* إعادة كل المباريات الحية للتسعير التلقائي (النسب تتبع سير المباراة من جديد) */
route("POST", "/api/admin/matches/auto-prices", A, async () => {
  let n = 0;
  await mutateState((ms) => ms.map((x) => { if (x.manualRates || x.manualPrices) { n++; return { ...x, manualRates: null, manualPrices: false }; } return x; }));
  await adminLog(`إعادة ${n} مباراة للتسعير التلقائي`);
  return { ok: true, count: n };
});
route("POST", "/api/admin/matches/flags", A, async ({ body }) => {
  const flag = body?.flag;
  if (!["suspended", "boosted", "frozen", "hot"].includes(flag)) throw bad("علم غير صالح");
  const value = !!body.value;
  await mutateState((ms) => ms.map((m) => (m.status === "ended" ? m : { ...m, [flag]: value })));
  await adminLog(`${flag} = ${value} لكل المباريات`);
  return { ok: true };
});
route("POST", "/api/admin/matches/end-live", A, async () => {
  const ended = new Set();
  const ms = await mutateState((arr) => {
    ended.clear();
    return arr.map((m) => (m.status === "live" && !m.real ? (ended.add(m.id), { ...m, status: "ended", minute: 90, endedAt: Date.now() }) : m));
  });
  const ev = ended.size ? await settleBets(ended, ms) : [];
  await adminLog(`إنهاء ${ended.size} مباراة مباشرة وتسوية`);
  return { ok: true, ended: ended.size, settled: ev.length };
});
route("POST", "/api/admin/real/sync", A, async ({ cfg }) => {
  const r = await syncReal(cfg, true);
  const st = await loadState();
  await adminLog("تحديث المباريات الحقيقية يدوياً");
  return { ok: true, ...r, real: st.matches.filter((m) => m.real).length, live: st.matches.filter((m) => m.real && m.status === "live").length, hasKey: !!fbKey() };
});
route("POST", "/api/admin/sim/advance", A, async ({ body }) => {
  const n = Math.min(500, Math.max(1, Math.floor(Number(body?.ticks) || 1)));
  const ended = new Set(), now = Date.now();
  const ms = await mutateState((arr) => {
    ended.clear();
    let cur = arr;
    for (let i = 0; i < n; i++) {
      const frozen = new Set(cur.filter((m) => m.frozen).map((m) => m.id));
      const t0 = tickMatches(cur);
      let nx = t0.matches.map((m, k) => (frozen.has(m.id) ? cur[k] : m));
      nx = driftUpcoming(nx);
      const prev = cur;
      nx = nx.map((m, k) => (m.status === "ended" && prev[k].status !== "ended" ? (ended.add(m.id), { ...m, endedAt: now }) : m));
      cur = nx;
    }
    return cur;
  });
  if (ended.size) await settleBets(ended, ms);
  await adminLog(`تقديم المباريات ${n} نبضة`);
  return { ok: true, ticks: n, endedMatches: ended.size };
});

/* ---- كتالوجات: إعادة للافتراضي + تصدير/استيراد ---- */
route("POST", "/api/admin/payments/reset", A, async () => { await saveConfig({ payments: clone(DEFAULT_PAYMENTS) }); await adminLog("إعادة طرق الدفع للافتراضي"); return clone(DEFAULT_PAYMENTS); });
route("POST", "/api/admin/vip/reset", A, async () => { await saveConfig({ vipTiers: clone(DEFAULT_VIP_TIERS) }); await adminLog("إعادة مستويات VIP للافتراضي"); return clone(DEFAULT_VIP_TIERS); });
route("POST", "/api/admin/config/reset", A, async () => {
  await saveConfig({ settings: clone(DEFAULT_SETTINGS), leagues: clone(DEFAULT_LEAGUES), vipTiers: clone(DEFAULT_VIP_TIERS), payments: clone(DEFAULT_PAYMENTS) });
  await adminLog("إعادة ضبط الإعدادات والكتالوجات للافتراضي");
  return { ok: true };
});
route("GET", "/api/admin/export", A, async ({ cfg }) => ({ version: 1, exportedAt: Date.now(), settings: cfg.settings, leagues: cfg.leagues, vipTiers: cfg.vipTiers, payments: cfg.payments }));
route("POST", "/api/admin/import", A, async ({ body }) => {
  const patch = {};
  if (body?.settings && typeof body.settings === "object") {
    const cur = (await getConfig(true)).settings, next = { ...cur };
    for (const k of Object.keys(body.settings)) if (k in DEFAULT_SETTINGS) next[k] = body.settings[k];
    patch.settings = next;
  }
  for (const k of ["leagues", "vipTiers", "payments"]) {
    if (body?.[k] === undefined) continue;
    if (!Array.isArray(body[k]) || !body[k].length) throw bad(`الحقل ${k} يجب أن يكون قائمة غير فارغة`);
    patch[k] = body[k];
  }
  if (!Object.keys(patch).length) throw bad("الملف لا يحوي بيانات صالحة");
  await saveConfig(patch);
  await adminLog(`استيراد نسخة احتياطية: ${Object.keys(patch).join("، ")}`);
  return { ok: true, imported: Object.keys(patch) };
});

/* ============================ طبقة HTTP ============================ */
const CORS = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-User-Id, X-Admin-Token, x-apisports-key, x-rapidapi-key, x-rapidapi-host",
  "Access-Control-Max-Age": "86400",
};
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...CORS, ...SEC });
  res.end(body);
}
async function readBody(req, limit = 200_000) {
  // Vercel يقرأ الجسم ويضعه في req.body مسبقاً (والستريم يكون قد استُهلك)
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) req.body = req.body.toString("utf8");
    if (typeof req.body === "string") { try { return req.body ? JSON.parse(req.body) : {}; } catch { throw bad("JSON غير صالح"); } }
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, "الطلب كبير جداً")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(bad("JSON غير صالح")); }
    });
    req.on("error", reject);
  });
}
/* ملفات الواجهة — تُستعمل محلياً فقط؛ على Vercel تخدمها المنصّة من dist */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};
function serveStatic(req, res, pathname) {
  const tryFile = (base, rel) => {
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return null;
    try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
  };
  const send = (file) => {
    const stat = fs.statSync(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": stat.size, "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache", ...SEC });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  };
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel) {
    const hit = (fs.existsSync(DIST) && tryFile(DIST, rel)) || tryFile(PUBLIC, rel);
    if (hit) return send(hit);
    if (path.extname(rel)) { res.writeHead(404, SEC); return res.end("Not found"); }
  }
  const index = fs.existsSync(DIST) && tryFile(DIST, "index.html");   // كل شاشات SPA: /leaderboard /vip /history ...
  if (index) return send(index);
  // مشروع خادم فقط (بلا dist): رد بسيط بدل صفحة خطأ
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...SEC });
  res.end(JSON.stringify({ ok: true, service: "Tawaqqo Arena API", health: "/api/health" }));
}

/* ============================ وسيط API-Sports (Football Widgets) ============================
 * الـ Widgets الرسمية (v3.1.0) تقبل data-url-football لتوجيه كل طلباتها إلى رابطك بدل api-sports مباشرة.
 * هنا نستقبل تلك الطلبات على /api/football/* ونضيف المفتاح من متغيّر البيئة API_FOOTBALL_KEY
 * (ترويسة x-apisports-key) فلا يظهر المفتاح في أي ملف يصل للمتصفح.
 * الحماية: قائمة مسارات مسموحة · GET فقط · تنقية المعاملات · حصر الدوريات في FOOTBALL_LEAGUES
 * · كاش بالذاكرة + Cache-Control للحافة · دمج الطلبات المتزامنة · حد لكل IP وحد للطلبات الصادرة.
 */
const FB_HOST = (process.env.API_FOOTBALL_HOST || "https://v3.football.api-sports.io").replace(/\/+$/, "");
const fbKey = () => process.env.API_FOOTBALL_KEY || process.env.APISPORTS_KEY || "";
/* الدوريات: افتراضياً كل دوريات وكؤوس العالم. لحصرها ضع FOOTBALL_LEAGUES=39,140,135 ... */
const FB_LEAGUES = (process.env.FOOTBALL_LEAGUES || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
const FB_LEAGUE_SET = new Set(FB_LEAGUES);
const FB_ALL_LEAGUES = FB_LEAGUES.length === 0;
const fbLeagueOk = (id) => FB_ALL_LEAGUES || FB_LEAGUE_SET.has(String(id));
const FB_DAYS_AHEAD = Math.min(14, Math.max(1, Number(process.env.FOOTBALL_DAYS_AHEAD) || 7));
const FB_MAX_PER_DAY = Math.max(10, Number(process.env.FOOTBALL_MAX_PER_DAY) || 100);
const FB_MIN_PER_DAY = Math.max(1, Number(process.env.FOOTBALL_MIN_PER_DAY) || 6);
/* حصة الطلبات اليومية لـ API-Sports (تُحفظ في قاعدة البيانات فتصمد عند إعادة تشغيل Vercel) */
const FB_DAILY_BUDGET = Math.max(10, Number(process.env.FOOTBALL_DAILY_BUDGET) || 166);
const FB_DAILY_REFRESH_MS = Math.max(10, Number(process.env.FOOTBALL_DAILY_REFRESH_MIN) || 60) * 60_000;   // اليوم والغد
const FB_FUTURE_REFRESH_MS = Math.max(1, Number(process.env.FOOTBALL_FUTURE_REFRESH_HOURS) || 6) * 3600_000; // بقية الأسبوع
const FB_LIVE_REFRESH_MS = Math.max(60, Number(process.env.FOOTBALL_LIVE_REFRESH_SEC) || 5400) * 1000;       // تحديث الحية/النتائج: كل 90 دقيقة
/** يحجز طلباً واحداً من حصة اليوم (UTC). share<1 يترك جزءاً من الحصة لأعمال أهم (الجلب الأساسي ونتائج التسوية) */
async function fbTakeDaily(share = 1) {
  try {
    const { meta } = await C();
    const cap = Math.max(1, Math.floor(FB_DAILY_BUDGET * share));
    const r = await meta.updateOne({ _id: `quota:fb:${utcDay(Date.now())}`, n: { $lt: cap } }, { $inc: { n: 1 } }, { upsert: true });
    return r.modifiedCount === 1 || r.upsertedCount === 1;
  } catch (e) {
    if (e?.code === 11000) return false;   // الوثيقة موجودة وبلغت السقف
    return true;                            // عطل آخر في العدّاد: لا نوقف الخدمة
  }
}
/* أولوية الدوريات عند تجاوز حد اليوم (الأهم أولاً): كؤوس أوروبا والعالم والدوريات الكبرى ثم العربية والبقية */
const FB_PRIORITY = [2, 3, 848, 1, 4, 5, 6, 9, 10, 15, 29, 30, 31, 32, 34, 39, 140, 135, 78, 61, 45, 143, 48, 81, 137, 66, 307, 233, 235, 12, 13, 11, 16, 17, 21, 22, 531, 88, 94, 144, 179, 203, 253, 262, 71, 128, 98, 169, 188, 292, 301, 305, 308, 332].map(String);
const fbPrio = (id) => { const i = FB_PRIORITY.indexOf(String(id)); return i < 0 ? 999 : i; };
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const FB_ORIGINS = (process.env.FOOTBALL_ALLOWED_ORIGINS || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
const FB_UPSTREAM_PER_MIN = Math.max(1, Number(process.env.FOOTBALL_UPSTREAM_PER_MIN) || 10);
const FB_IP_PER_MIN = Math.max(10, Number(process.env.FOOTBALL_IP_PER_MIN) || 120);
/* المسارات المسموحة ومدة الكاش بالثواني (الأحداث الحيّة قصيرة، والثابتة طويلة) */
const FB_ENDPOINTS = {
  "fixtures": 20, "fixtures/events": 20, "fixtures/lineups": 60, "fixtures/statistics": 30, "fixtures/players": 30,
  "fixtures/headtohead": 600, "fixtures/rounds": 3600,
  "standings": 300, "leagues": 3600, "leagues/seasons": 86400,
  "teams": 3600, "teams/statistics": 600, "teams/seasons": 86400,
  "players": 1800, "players/squads": 3600, "players/seasons": 86400,
  "venues": 86400, "injuries": 600, "trophies": 86400, "sidelined": 3600, "coachs": 86400, "countries": 86400, "timezone": 86400,
};
const FB_PARAMS = new Set(["id", "ids", "live", "league", "season", "date", "from", "to", "team", "fixture", "round", "timezone", "status", "last", "next", "h2h", "player", "page", "search", "country", "type", "current", "name", "code", "venue", "coach"]);
const FB_VALUE_RE = /^[\w\s.,:+\-\/]{1,100}$/;
const fbCache = new Map();      // key -> { body, exp, ttl }
const fbInflight = new Map();   // key -> Promise<entry>
const fbIpHits = new Map();     // ip -> { w, n }
const fbBudget = { w: 0, n: 0 };

const fbEnvelope = (sub, errors) => ({ get: sub, parameters: [], errors, results: 0, paging: { current: 1, total: 1 }, response: [] });
function fbSend(res, status, body, cache) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const cc = cache && status === 200
    ? `public, max-age=${Math.min(cache, 10)}, s-maxage=${cache}, stale-while-revalidate=15`
    : "no-store";
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": cc, ...CORS, ...SEC });
  res.end(text);
}
function fbTakeUpstreamToken() {
  const w = Math.floor(Date.now() / 60_000);
  if (fbBudget.w !== w) { fbBudget.w = w; fbBudget.n = 0; }
  if (fbBudget.n >= FB_UPSTREAM_PER_MIN) return false;
  fbBudget.n++;
  return true;
}
function fbIpAllowed(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
  const w = Math.floor(Date.now() / 60_000);
  if (fbIpHits.size > 5000) fbIpHits.clear();
  const h = fbIpHits.get(ip);
  if (!h || h.w !== w) { fbIpHits.set(ip, { w, n: 1 }); return true; }
  return ++h.n <= FB_IP_PER_MIN;
}
function fbOriginAllowed(req) {
  if (!FB_ORIGINS.length) return true;
  const origin = String(req.headers.origin || "").replace(/\/+$/, "");
  if (origin) return FB_ORIGINS.includes(origin);
  const ref = String(req.headers.referer || "");
  if (ref) { try { return FB_ORIGINS.includes(new URL(ref).origin); } catch { return false; } }
  return true;
}
const fbHasErrors = (j) => { const e = j?.errors; return Array.isArray(e) ? e.length > 0 : !!e && typeof e === "object" && Object.keys(e).length > 0; };
/* حصر النتائج في الدوريات المسموحة (الافتراضي: كل الدوريات) */
function fbFilterLeagues(endpoint, json) {
  if (!["fixtures", "leagues", "standings"].includes(endpoint) || !Array.isArray(json?.response)) return json;
  const response = json.response.filter((it) => fbLeagueOk(it?.league?.id));
  return { ...json, response, results: response.length };
}
async function fbUpstream(endpoint, qs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`${FB_HOST}/${endpoint}${qs ? "?" + qs : ""}`, { headers: { "x-apisports-key": fbKey(), Accept: "application/json" }, signal: ctrl.signal });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new HttpError(502, "ردّ غير صالح من مزوّد البيانات"); }
    return { status: r.status, json };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "تعذّر الوصول إلى مزوّد البيانات");
  } finally { clearTimeout(t); }
}
async function fbEntry(key, endpoint, qs, ttl) {
  const now = Date.now();
  const hit = fbCache.get(key);
  if (hit && hit.exp > now) return { entry: hit, state: "HIT" };
  if (fbInflight.has(key)) return { entry: await fbInflight.get(key), state: "WAIT" };
  const staleOk = hit && now - hit.exp < 10 * 60_000;
  const p = (async () => {
    if (!fbTakeUpstreamToken() || !(await fbTakeDaily(0.6))) {
      if (staleOk) return { ...hit, stale: true };
      throw new HttpError(429, "تجاوز حدّ الطلبات مؤقتاً، حاول بعد قليل");
    }
    try {
      const { status, json } = await fbUpstream(endpoint, qs);
      if (status >= 500) { if (staleOk) return { ...hit, stale: true }; throw new HttpError(502, "مزوّد البيانات غير متاح حالياً"); }
      if (fbHasErrors(json)) {            // أخطاء الخطة/الحد اليومي: تُمرَّر كما هي ولا تُخزَّن
        if (staleOk) return { ...hit, stale: true };
        return { body: JSON.stringify(json), exp: 0, ttl: 0 };
      }
      const entry = { body: JSON.stringify(fbFilterLeagues(endpoint, json)), exp: Date.now() + ttl * 1000, ttl };
      if (fbCache.size > 300) fbCache.delete(fbCache.keys().next().value);
      fbCache.set(key, entry);
      return entry;
    } catch (e) {
      if (staleOk) return { ...hit, stale: true };
      throw e;
    }
  })().finally(() => fbInflight.delete(key));
  fbInflight.set(key, p);
  return { entry: await p, state: "MISS" };
}
async function footballProxy(req, res, url, pathname) {
  const sub = pathname.replace(/^\/api\/football\/?/, "").replace(/\/+$/, "");
  try {
    if (req.method !== "GET") return fbSend(res, 405, fbEnvelope(sub, { method: "GET فقط" }));
    if (!fbOriginAllowed(req)) return fbSend(res, 403, fbEnvelope(sub, { origin: "أصل غير مسموح" }));
    if (!fbIpAllowed(req)) return fbSend(res, 429, fbEnvelope(sub, { rateLimit: "طلبات كثيرة، حاول بعد قليل" }));

    if (sub === "health") {
      let usedToday = null;
      try { const { meta } = await C(); usedToday = (await meta.findOne({ _id: `quota:fb:${utcDay(Date.now())}` }))?.n ?? 0; } catch { /* العدّاد اختياري */ }
      return fbSend(res, 200, { ok: true, configured: !!fbKey(), leagues: FB_LEAGUES, dailyBudget: FB_DAILY_BUDGET, usedToday });
    }
    if (sub === "_status") {   // للأدمن فقط: حالة الخطة والحد اليومي (بدون إظهار المفتاح أو بيانات الحساب)
      if (!verifyAdminToken(req.headers["x-admin-token"])) return fbSend(res, 401, { ok: false, error: "يلزم تسجيل الدخول كمدير" });
      if (!fbKey()) return fbSend(res, 200, { ok: true, keyConfigured: false });
      const { json } = await fbUpstream("status", "");
      const r = json?.response || {};
      return fbSend(res, 200, { ok: true, keyConfigured: true, plan: r.subscription?.plan ?? null, active: r.subscription?.active ?? null, requests: r.requests ?? null, errors: json?.errors ?? [] });
    }

    const ttl = FB_ENDPOINTS[sub];
    if (!ttl) return fbSend(res, 404, fbEnvelope(sub, { endpoint: "مسار غير مسموح" }));
    if (!fbKey()) return fbSend(res, 503, fbEnvelope(sub, { server: "API_FOOTBALL_KEY غير مضبوط في السيرفر" }));

    /* تنقية المعاملات (قائمة بيضاء + حدود الطول) */
    const params = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (!FB_PARAMS.has(k) || !FB_VALUE_RE.test(v)) continue;
      params.set(k, v);
    }
    /* حصر الدوريات */
    const leagueTokens = (v) => String(v).split(/[-,]/).filter(Boolean);
    if (params.has("league") && !leagueTokens(params.get("league")).every((t) => fbLeagueOk(t)))
      return fbSend(res, 403, fbEnvelope(sub, { league: "دوري غير مسموح" }));
    if (sub === "standings" && !params.has("league")) return fbSend(res, 403, fbEnvelope(sub, { league: "league مطلوب" }));
    if (sub === "fixtures" && params.has("live")) {
      const lv = params.get("live");
      if (lv === "all") params.set("live", FB_ALL_LEAGUES ? "all" : FB_LEAGUES.join("-"));
      else if (lv !== "all" && !leagueTokens(lv).every((t) => fbLeagueOk(t))) return fbSend(res, 403, fbEnvelope(sub, { live: "دوري غير مسموح" }));
    }
    params.sort();
    const qs = params.toString();
    const { entry, state } = await fbEntry(`${sub}?${qs}`, sub, qs, ttl);
    res.setHeader("X-Football-Cache", entry.stale ? "STALE" : state);
    return fbSend(res, 200, entry.body, entry.exp > Date.now() ? Math.max(5, Math.min(ttl, Math.ceil((entry.exp - Date.now()) / 1000))) : 0);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`✖ football ${req.url}:`, e);
    return fbSend(res, status, fbEnvelope(sub, { proxy: status === 500 ? "خطأ داخلي في الخادم" : e.message }));
  }
}

/* مسارات GET لا تستعمل بيانات المباريات: لا نقرأ ولا نكتب وثيقة المباريات لها */
const NO_MATCH_PATHS = new Set([
  "/api/me", "/api/notices", "/api/referrals", "/api/referrals/link", "/api/friends", "/api/history",
  "/api/wallet", "/api/wallet/transactions", "/api/leaderboard", "/api/vip", "/api/bonus/daily",
]);

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (pathname === "/api/football" || pathname.startsWith("/api/football/")) return await footballProxy(req, res, url, pathname);
    if (!pathname.startsWith("/api/") && pathname !== "/api") {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, SEC); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body: {}, user: null };
      ctx.cfg = await getConfig();
      if (r.admin) {
        const s = verifyAdminToken(req.headers["x-admin-token"]);
        if (!s) throw new HttpError(401, "يلزم تسجيل الدخول كمدير");
      } else if (r.auth !== false) {
        ctx.user = await authUser(req);
        // آخر ظهور: يُحدَّث على أي طلب موثّق (بحد أدنى 20 ثانية بين كتابتين) — للضيف المشترك (0) لا يُسجَّل
        if (ctx.user._id && Date.now() - (ctx.user.lastSeenAt || 0) > 20_000) {
          const now = Date.now();
          ctx.user.lastSeenAt = now;
          (await C()).users.updateOne({ _id: ctx.user._id }, { $set: { lastSeenAt: now } }).catch(() => undefined);
        }
        if (ctx.cfg.settings.maintenance && req.method !== "GET") throw new HttpError(503, ctx.cfg.settings.maintenanceMsg);
      }
      if (r.sync !== false) {
        const p = pathname.replace(/\/$/, "");
        if (r.admin) ctx.matches = /\/settle$/.test(p) ? (await loadState()).matches : [];
        else if (req.method === "GET" && NO_MATCH_PATHS.has(p)) ctx.matches = [];
        else if (req.method === "GET" && p === "/api/bets") ctx.matches = (await loadState()).matches;   // قراءة فقط بلا كتابة
        else ctx.matches = await syncMatches();
      }
      if (req.method !== "GET" && req.method !== "DELETE") ctx.body = (await readBody(req)) || {};
      const out = await r.handler(ctx);
      return sendJson(res, 200, out === undefined ? { ok: true } : out);
    }
    sendJson(res, 404, { ok: false, error: "المسار غير موجود" });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`✖ ${req.method} ${req.url}:`, e);
    try { sendJson(res, status, { ok: false, error: status === 500 ? "خطأ داخلي في الخادم" : e.message }); } catch { /* ignore */ }
  }
}

/* ---- تشغيل محلي: node server.js (لا يعمل على Vercel، فالمنصّة تستدعي handler مباشرة) ---- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain && !process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(PORT, () => {
    console.log(`\n🏟  ساحة التوقّع تعمل على http://localhost:${PORT}`);
    console.log(`   MongoDB : ${process.env.MONGODB_URI ? "مضبوط ✔" : "⚠ MONGODB_URI غير مضبوط"}`);
    console.log(`   الواجهة : ${fs.existsSync(DIST) ? "dist ✔" : "غير مبنيّة (npm run build)"}`);
    console.log(`   الأدمن  : ${process.env.ADMIN_PIN ? "برمز من ADMIN_PIN" : "⚠ الرمز الافتراضي 123456 — غيّره عبر ADMIN_PIN"}\n`);
  });
}
