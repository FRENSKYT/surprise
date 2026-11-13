// Envoie « Plus que 10 minutes… » puis « Nouvel indice disponible » chaque jour.
// Les heures sont lues directement dans index.html (HEURE, HEURE_CADEAU, DEBUT).
import fs from 'node:fs';

const NB_INDICES = 29;                 // nombre d'indices avant le cadeau
const AVANCE_MIN = 10;                 // le rappel part X minutes avant
const SITE = process.env.SITE_URL || 'https://frenskyt.github.io/surprise/';

const src = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const lire = (nom) => { const m = src.match(new RegExp(`const ${nom}\\s*=\\s*([^;]+);`)); if (!m) throw new Error(nom + ' introuvable'); return JSON.parse(m[1]); };
const HEURE = lire('HEURE'), HEURE_CADEAU = lire('HEURE_CADEAU'), DEBUT = lire('DEBUT');

// Instant UTC correspondant à une date/heure de Paris (gère l'heure d'été/hiver).
function parisVersUtc(y, mo, d, h) {
  let t = Date.UTC(y, mo - 1, d, h);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    const vu = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    t += Date.UTC(y, mo - 1, d, h) - vu;
  }
  return t;
}

// Liste de tous les événements (rappel + sortie) jusqu'au cadeau.
const evenements = [];
for (let k = 0; k <= NB_INDICES; k++) {
  const j = new Date(Date.UTC(DEBUT[0], DEBUT[1] - 1, DEBUT[2] + k));
  const cadeau = k === NB_INDICES;
  const t = parisVersUtc(j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate(), cadeau ? HEURE_CADEAU : HEURE);
  evenements.push({ t: t - AVANCE_MIN * 60e3, sujet: cadeau ? `🎁 Plus que ${AVANCE_MIN} minutes avant ton cadeau…` : `⏳ Plus que ${AVANCE_MIN} minutes avant le prochain indice`, texte: cadeau ? 'Le grand moment approche. Prépare-toi…' : `L'indice n°${k + 1} arrive dans ${AVANCE_MIN} minutes.` });
  evenements.push({ t, sujet: cadeau ? '🎁 Ton cadeau t\'attend !' : `✨ Nouvel indice disponible (n°${k + 1})`, texte: cadeau ? 'C\'est l\'heure. Va ouvrir ton cadeau 🎉' : `L'indice n°${k + 1} vient d'apparaître. À toi de jouer 🕵️‍♀️` });
}

async function envoyer(e) {
  const dest = (process.env.DESTINATAIRES || '').split(/[,;\s]+/).filter(Boolean);
  let ok = false;
  if (dest.length && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const nodemailer = (await import('nodemailer')).default;
    const tr = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: +(process.env.SMTP_PORT || 465), secure: (process.env.SMTP_PORT || '465') === '465', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await tr.sendMail({
      from: `"Une surprise pour toi" <${process.env.SMTP_USER}>`, bcc: dest, subject: e.sujet,
      text: `${e.texte}\n\n${SITE}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:28px;border-radius:20px;background:#1c2a6b;color:#fff;text-align:center"><h2 style="margin:0 0 12px">${e.sujet}</h2><p style="font-size:16px;opacity:.9">${e.texte}</p><a href="${SITE}" style="display:inline-block;margin-top:14px;padding:12px 26px;border-radius:99px;background:#ffd36b;color:#2a1a00;font-weight:700;text-decoration:none">Ouvrir le site</a></div>`,
    });
    console.log(`Mail envoyé à ${dest.length} destinataire(s) : ${e.sujet}`); ok = true;
  }
  if (process.env.NTFY_TOPIC) {
    // Envoi en JSON pour que les accents et emojis du titre passent correctement.
    const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title: e.sujet, message: e.texte, click: SITE, priority: 4 }) });
    console.log(`Push ntfy : ${r.status}`); ok = true;
  }
  if (!ok) console.log('Aucun moyen d\'envoi configuré (secrets manquants) :', e.sujet);
}

const attendre = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

// --- Push ntfy : programmé à l'avance chez ntfy (jusqu'à 3 jours), qui livre à l'heure pile. ---
// GitHub saute souvent des exécutions planifiées : il suffit donc qu'UNE exécution passe
// tous les 3 jours. Le fichier d'état évite de programmer deux fois la même notification.
const ETAT = new URL('../notifications-programmees.json', import.meta.url);
async function programmerNtfy() {
  if (!process.env.NTFY_TOPIC) { console.log('NTFY_TOPIC absent : pas de push programmé.'); return; }
  let deja = []; try { deja = JSON.parse(fs.readFileSync(ETAT, 'utf8')); } catch {}
  const maintenant = Date.now(), horizon = maintenant + 70 * 3600e3;   // ntfy.sh accepte 3 jours max
  let n = 0;
  for (const e of evenements) {
    const cle = `${new Date(e.t).toISOString()} ${e.sujet}`;
    if (e.t < maintenant + 15e3 || e.t > horizon || deja.includes(cle)) continue;
    const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title: e.sujet, message: e.texte, click: SITE, priority: 4, delay: String(Math.floor(e.t / 1000)) }) });
    const corps = await r.text();
    if (!r.ok) { console.log(`Échec ntfy (${r.status}) pour ${cle} : ${corps}`); continue; }
    deja.push(cle); n++;
    console.log(`Programmé : ${new Date(e.t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} — ${e.sujet}`);
  }
  deja = deja.filter(c => Date.parse(c.slice(0, 24)) > maintenant - 7 * 864e5);   // ménage
  fs.writeFileSync(ETAT, JSON.stringify(deja.sort(), null, 1) + '\n');
  console.log(n ? `${n} notification(s) programmée(s).` : 'Rien de nouveau à programmer.');
}

// --- Mail : envoyé sur le moment (pas de programmation possible), au mieux. ---
async function mailsDeLHeure() {
  if (!process.env.SMTP_USER) return;
  const debut = Math.floor(Date.now() / 3600e3) * 3600e3 + 30 * 60e3;
  const a_faire = evenements.filter(e => e.t >= debut && e.t < debut + 3600e3);
  const ntfy = process.env.NTFY_TOPIC; delete process.env.NTFY_TOPIC;      // le push est déjà programmé
  for (const e of a_faire) { await attendre(e.t - Date.now()); await envoyer(e); }
  if (ntfy) process.env.NTFY_TOPIC = ntfy;
}

if (process.argv[2] === 'test') {
  await envoyer({ sujet: '🔔 Test des notifications', texte: 'Si tu lis ceci, les notifications marchent.' });
} else {
  await programmerNtfy();
  await mailsDeLHeure();
}
