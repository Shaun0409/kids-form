// Vercel serverless function: POST /api/submit
// Port of the FastAPI endpoint. Secrets live in Vercel environment variables.
//   RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME (optional, default "Cosmic Charity")
//   DEMO_MODE=true  -> skips Resend and pretends to send (fallback / dry run)
//   MAX_TOTAL=200   -> hard cap on emails per server instance (protects your Resend quota)

const COOLDOWN_MS = 60 * 1000;          // one email per address per minute
const IP_WINDOW_MS = 10 * 60 * 1000;    // ...and at most 10 per IP per 10 minutes
const IP_MAX = 10;
const lastByEmail = new Map();          // best-effort memory; resets when the function restarts
const hitsByIp = new Map();
let total = 0;

const SIGNS = [
  { name: 'Aquarius', symbol: '♒', from: 120, traits: [
    'I am an original thinker who sees solutions nobody else has imagined.',
    'I have a big heart for people and love building things that help others.',
    'I stay curious and calm, even when the galaxy gets unpredictable.' ] },
  { name: 'Pisces', symbol: '♓', from: 219, traits: [
    'I have a rich imagination that turns dreams into real plans.',
    'I listen deeply, so my crewmates always feel understood.',
    'I am creative enough to find beauty in every corner of the universe.' ] },
  { name: 'Aries', symbol: '♈', from: 321, traits: [
    'I charge ahead with courage when a mission needs a bold leader.',
    'I bring energy that lights up every crew I join.',
    'I am not afraid to go first, and I learn fast from every try.' ] },
  { name: 'Taurus', symbol: '♉', from: 420, traits: [
    'I am steady and dependable, the crew member everyone can count on.',
    'I have the patience to build great things one careful step at a time.',
    'I care about quality and put real effort into everything I make.' ] },
  { name: 'Gemini', symbol: '♊', from: 521, traits: [
    'I am a quick learner who loves asking questions and sharing ideas.',
    'I communicate in ways that bring different people together.',
    'I adapt fast, so no new planet can slow me down.' ] },
  { name: 'Cancer', symbol: '♋', from: 621, traits: [
    'I care deeply about my crew and make every team feel like home.',
    'I have strong instincts that guide me through tricky moments.',
    'I protect what matters and never give up on people.' ] },
  { name: 'Leo', symbol: '♌', from: 723, traits: [
    'I lead with a warmth and confidence that makes others believe in the mission.',
    'I have creative flair that makes ordinary jobs shine.',
    'I am generous and love cheering my team on so we all shine.' ] },
  { name: 'Virgo', symbol: '♍', from: 823, traits: [
    'I notice the details others miss, which keeps every mission safe.',
    'I am practical and love turning messy problems into clear plans.',
    'I work hard and always look for ways to improve.' ] },
  { name: 'Libra', symbol: '♎', from: 923, traits: [
    'I am fair and thoughtful, great at helping a crew agree.',
    'I have a natural sense of balance and style.',
    'I make friends easily and bring peace to any team.' ] },
  { name: 'Scorpio', symbol: '♏', from: 1023, traits: [
    'I am determined and never quit before the mission is complete.',
    'I am brave enough to dig deep until I find the truth.',
    'I am loyal to my crew and fiercely focused on our goals.' ] },
  { name: 'Sagittarius', symbol: '♐', from: 1122, traits: [
    'I possess an adventurous spirit that loves exploring wide, open cosmic horizons.',
    'I maintain an unshakeable optimistic outlook that brings luck to every journey.',
    'I speak truth with absolute sincerity and love gathering cosmic wisdom.' ] },
  { name: 'Capricorn', symbol: '♑', from: 1222, traits: [
    'I am immensely responsible and practical when managing deep-space outposts.',
    'I have absolute determination to climb to the peak of any career pyramid I choose.',
    'I hold a natural inner wisdom that guides me through tough galaxy riddles.' ] },
];

const TEMPLATES = [
  'The stars outline a direct path for you to become an elite {job}. Your unique cosmic talents make you exactly what this profession needs to thrive!',
  'The universe smiles upon your dream to be a {job}. Your star sign alignment provides you with the precision and creativity to conquer this career perfectly!',
  'As a future {job}, your cosmic configuration grants you the power to break boundaries and build incredible changes. Follow that starlight trajectory!',
  'A destiny as a {job} matches your innate strengths flawlessly. Keep reaching high, because the universe is backing your steps all the way!',
];

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getSign(month, day) {
  const md = month * 100 + day;
  for (let i = SIGNS.length - 1; i >= 0; i--) if (md >= SIGNS[i].from) {
    // Dec 22+ is Capricorn; Jan 1-19 (md < 120) wraps to Capricorn too
    return SIGNS[i];
  }
  return SIGNS[SIGNS.length - 1];
}

function parseBirthdate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > Date.now()) return null;
  return { month: mo, day: d };
}

function buildHtml(name, sign, job) {
  const traits = sign.traits.map(t => `<li>${esc(t)}</li>`).join('');
  const line = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)].replace('{job}', esc(job));
  return `
    <h1>Star Map Decoded!</h1>
    <p>Hi <strong>${esc(name)}</strong>, thanks for filling out our cosmic form.</p>
    <p><strong>Your star sign:</strong> ${sign.name} ${sign.symbol}</p>
    <h2>What makes you special</h2>
    <ul>${traits}</ul>
    <h2>Dream job insight</h2>
    <p>${line}</p>
    <hr>
    <p>May the stars guide you on your journey!</p>`;
}

const fail = (res, code, message, error) =>
  res.status(code).json({ status: 'error', message, error, timestamp: new Date().toISOString() });

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');

  const body = req.body || {};
  const name = clean(body.fullName, 60);
  const job = clean(body.dreamJob, 60);
  const email = clean(body.email, 120);
  const bd = parseBirthdate(body.birthdate);

  if (!name) return fail(res, 400, 'Please enter your name.');
  if (!bd) return fail(res, 400, 'Please enter a valid birthday.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Please enter a valid email address.');
  if (!job) return fail(res, 400, 'Please enter your dream job.');

  // Basic abuse protection (this is a public link that sends email from your domain)
  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const recent = (hitsByIp.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_MAX) return fail(res, 429, 'Too many tries from this device. Please wait a few minutes.');
  const key = email.toLowerCase();
  if (now - (lastByEmail.get(key) || 0) < COOLDOWN_MS) return fail(res, 429, 'We just sent an email to that address. Please wait a minute.');
  if (total >= Number(process.env.MAX_TOTAL || 200)) return fail(res, 429, 'The mission limit has been reached. Please see the team.');

  const sign = getSign(bd.month, bd.day);
  const html = buildHtml(name, sign, job);
  const ok = () => {
    recent.push(now); hitsByIp.set(ip, recent);
    lastByEmail.set(key, now); total++;
    return res.status(200).json({
      status: 'ok', message: 'Mission delivered via e-mail',
      zodiac: sign.name, symbol: sign.symbol, timestamp: new Date().toISOString(),
    });
  };

  if (process.env.DEMO_MODE === 'true') return ok();

  const { RESEND_API_KEY: apiKey, RESEND_FROM_EMAIL: fromEmail } = process.env;
  const fromName = process.env.RESEND_FROM_NAME || 'Cosmic Charity';
  if (!apiKey || !fromEmail) return fail(res, 500, 'The server is not set up yet.');

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`, to: [email],
        subject: 'Your cosmic Career Day Result 🚀', html,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Resend error', r.status, data.name, data.message); // no addresses logged
      return fail(res, 502, "We couldn't send your email.", data.message || 'E-mail service unavailable');
    }
    return ok();
  } catch (e) {
    console.error('Send failed:', e.message);
    return fail(res, 502, "We couldn't send your email.", 'Could not reach the e-mail service.');
  }
};
