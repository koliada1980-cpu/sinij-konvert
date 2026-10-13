import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secretKeys = (() => {
  try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); }
  catch { return {}; }
})();
const backendKey = serviceRoleKey || secretKeys.default || "";
const legacyBackendAuth = backendKey.startsWith("sb_") ? "" : backendKey;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function fail(message: string, status = 400) {
  return respond({ error: message }, status);
}

async function db(path: string, method = "GET", body?: unknown, prefer?: string) {
  const headers: Record<string, string> = { apikey: backendKey };
  if (legacyBackendAuth) headers.Authorization = `Bearer ${legacyBackendAuth}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${projectUrl}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(typeof data === "object" ? (data?.message || data?.hint || "Ошибка базы данных") : String(data));
  return data;
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const profileSelect = "id,name,agency,city,currency,reward,payout_details,greeting,invite_text,invite_slug,formats";
const clientProfile = (p: any) => ({
  name: p.name, agency: p.agency, city: p.city, currency: p.currency, reward: Number(p.reward),
  details: p.payout_details, greeting: p.greeting, invite: p.invite_text, slug: p.invite_slug, formats: p.formats,
});

async function getProfileBySlug(slug: string) {
  const rows = await db(`agent_profiles?select=${profileSelect}&invite_slug=eq.${encodeURIComponent(slug)}&limit=1`);
  return rows?.[0] ?? null;
}

async function getReferrer(token: string) {
  if (!token || token.length < 32 || token.length > 128) return null;
  const rows = await db(`referrers?select=id,agent_id,display_name,token_hash&id=not.is.null&token_hash=eq.${await hashToken(token)}&limit=1`);
  return rows?.[0] ?? null;
}

async function getUser(req: Request) {
  const bearer = req.headers.get("authorization") ?? "";
  const match = bearer.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1].startsWith("sb_")) return null;
  const response = await fetch(`${projectUrl}/auth/v1/user`, {
    headers: { apikey: backendKey, Authorization: `Bearer ${match[1]}` },
  });
  if (!response.ok) return null;
  return await response.json();
}

async function ensureAgentProfile(user: any) {
  let rows = await db(`agent_profiles?select=${profileSelect}&id=eq.${user.id}&limit=1`);
  if (rows?.[0]) return rows[0];
  const slug = "nikolay-kaliberda";
  rows = await db("agent_profiles?on_conflict=id&select=*", "POST", {
    id: user.id, invite_slug: slug,
  }, "resolution=merge-duplicates,return=representation");
  return rows?.[0] ?? null;
}

async function agentSnapshot(agentId: string) {
  const [profiles, leads, envelopes, referrers] = await Promise.all([
    db(`agent_profiles?select=${profileSelect}&id=eq.${agentId}&limit=1`),
    db(`leads?select=id,referrer_id,name,contact,need,comment,status,created_at&agent_id=eq.${agentId}&order=created_at.desc`),
    db(`envelopes?select=id,lead_id,referrer_id,format,amount,message,payout_details,opened_at,created_at&agent_id=eq.${agentId}&order=created_at.desc`),
    db(`referrers?select=id,display_name&agent_id=eq.${agentId}`),
  ]);
  const names = new Map((referrers ?? []).map((r: any) => [r.id, r.display_name]));
  return {
    profile: clientProfile(profiles?.[0]),
    leads: (leads ?? []).map((l: any) => ({ ...l, step: Number(l.status), referrer: names.get(l.referrer_id) ?? "Клиент" })),
    envelopes: (envelopes ?? []).map((e: any) => ({ ...e, opened: !!e.opened_at, details: e.payout_details })),
  };
}

async function clientSnapshot(referrer: any) {
  const [profiles, leads, envelopes] = await Promise.all([
    db(`agent_profiles?select=${profileSelect}&id=eq.${referrer.agent_id}&limit=1`),
    db(`leads?select=id,name,contact,need,comment,status,created_at&referrer_id=eq.${referrer.id}&order=created_at.desc`),
    db(`envelopes?select=id,lead_id,format,amount,message,payout_details,opened_at,created_at&referrer_id=eq.${referrer.id}&order=created_at.desc`),
  ]);
  return {
    profile: clientProfile(profiles?.[0]),
    leads: (leads ?? []).map((l: any) => ({ ...l, step: Number(l.status), referrer: "Вы" })),
    envelopes: (envelopes ?? []).map((e: any) => ({ ...e, opened: !!e.opened_at, details: e.payout_details })),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Метод не поддерживается", 405);
  if (!projectUrl || !backendKey) return fail("Серверная часть не настроена", 503);

  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "public_profile") {
      const slug = String(body.slug ?? "").slice(0, 80);
      const profile = await getProfileBySlug(slug);
      if (!profile) return fail("Профиль риелтора ещё не настроен", 404);
      return respond({ profile: clientProfile(profile) });
    }

    if (action === "create_lead") {
      const name = String(body.name ?? "").trim().slice(0, 120);
      const contact = String(body.contact ?? "").trim().slice(0, 160);
      const need = String(body.need ?? "");
      const comment = String(body.comment ?? "").trim().slice(0, 1200);
      const displayName = String(body.referrerName ?? "").trim().slice(0, 100) || "Клиент";
      if (!name || !contact || !["Купить", "Продать", "Аренда"].includes(need)) return fail("Проверьте имя, контакт и задачу.");

      let referrer = body.clientToken ? await getReferrer(String(body.clientToken)) : null;
      let createdToken = "";
      if (body.clientToken && !referrer) return fail("Ссылка кошелька недействительна или устарела.", 401);
      if (!referrer) {
        const profile = await getProfileBySlug(String(body.slug ?? "nikolay-kaliberda"));
        if (!profile) return fail("Профиль риелтора ещё не настроен", 404);
        createdToken = randomToken();
        const rows = await db("referrers?select=id,agent_id,display_name,token_hash", "POST", {
          agent_id: profile.id, display_name: displayName, token_hash: await hashToken(createdToken),
        }, "return=representation");
        referrer = rows?.[0];
      } else if (displayName !== "Клиент") {
        await db(`referrers?id=eq.${referrer.id}`, "PATCH", { display_name: displayName }, "return=minimal");
      }
      await db("leads?select=id,name,contact,need,comment,status,created_at,referrer_id", "POST", {
        agent_id: referrer.agent_id, referrer_id: referrer.id, name, contact, need, comment, status: 0,
      }, "return=representation");
      return respond({ ...(await clientSnapshot(referrer)), clientToken: createdToken || String(body.clientToken) });
    }

    if (action === "client_portal" || action === "open_envelope") {
      const referrer = await getReferrer(String(body.clientToken ?? ""));
      if (!referrer) return fail("Ссылка кошелька недействительна или устарела.", 401);
      if (action === "open_envelope") {
        const envelopeId = String(body.envelopeId ?? "");
        const rows = await db(`envelopes?id=eq.${encodeURIComponent(envelopeId)}&referrer_id=eq.${referrer.id}&opened_at=is.null`, "PATCH", { opened_at: new Date().toISOString() }, "return=representation");
        if (!rows?.length) return fail("Конверт не найден или уже открыт.", 404);
      }
      return respond(await clientSnapshot(referrer));
    }

    const user = await getUser(req);
    if (!user?.id) return fail("Войдите в аккаунт риелтора.", 401);
    const profile = await ensureAgentProfile(user);
    if (!profile) return fail("Не удалось загрузить профиль риелтора.", 500);

    if (action === "agent_data") return respond(await agentSnapshot(user.id));

    if (action === "update_profile") {
      const allowed = ["name", "agency", "city", "currency", "reward", "payout_details", "greeting", "invite_text", "formats"];
      const updates: Record<string, unknown> = {};
      for (const key of allowed) if (Object.hasOwn(body.profile ?? {}, key)) updates[key] = body.profile[key];
      if ("reward" in updates) updates.reward = Math.max(0, Math.min(Number(updates.reward) || 0, 100000000));
      if ("currency" in updates) updates.currency = String(updates.currency).slice(0, 8);
      if ("name" in updates) updates.name = String(updates.name).trim().slice(0, 120);
      if ("agency" in updates) updates.agency = String(updates.agency).trim().slice(0, 120);
      if ("city" in updates) updates.city = String(updates.city).trim().slice(0, 120);
      if ("greeting" in updates) updates.greeting = String(updates.greeting).slice(0, 800);
      if ("invite_text" in updates) updates.invite_text = String(updates.invite_text).slice(0, 1600);
      if ("payout_details" in updates) updates.payout_details = String(updates.payout_details).slice(0, 1000);
      if ("formats" in updates && typeof updates.formats !== "object") delete updates.formats;
      await db(`agent_profiles?id=eq.${user.id}`, "PATCH", updates, "return=minimal");
      return respond(await agentSnapshot(user.id));
    }

    if (action === "update_status") {
      const status = Number(body.status);
      if (!Number.isInteger(status) || status < 0 || status > 4) return fail("Недопустимый статус.");
      const rows = await db(`leads?id=eq.${encodeURIComponent(String(body.leadId))}&agent_id=eq.${user.id}&status=neq.5`, "PATCH", { status }, "return=representation");
      if (!rows?.length) return fail("Лид не найден.", 404);
      return respond(await agentSnapshot(user.id));
    }

    if (action === "send_envelope") {
      const leadId = String(body.leadId ?? "");
      const leads = await db(`leads?select=id,agent_id,referrer_id,status&id=eq.${encodeURIComponent(leadId)}&agent_id=eq.${user.id}&limit=1`);
      const lead = leads?.[0];
      if (!lead || Number(lead.status) !== 4) return fail("Сначала переведите лид в статус «Сделка закрыта».", 409);
      const format = String(body.format ?? "").slice(0, 100);
      const amount = String(body.amount ?? "").trim().slice(0, 100);
      const message = String(body.message ?? "").trim().slice(0, 1200);
      if (!format || !amount || !message) return fail("Заполните формат, сумму и личное сообщение.");
      const rows = await db("envelopes?select=id,lead_id,referrer_id,format,amount,message,payout_details,opened_at,created_at", "POST", {
        agent_id: user.id, referrer_id: lead.referrer_id, lead_id: lead.id,
        format, amount, message, payout_details: String(body.payoutDetails ?? "").slice(0, 1000),
      }, "return=representation");
      await db(`leads?id=eq.${lead.id}&agent_id=eq.${user.id}&status=eq.4`, "PATCH", { status: 5 }, "return=minimal");
      return respond(await agentSnapshot(user.id));
    }

    return fail("Неизвестная команда.", 404);
  } catch (error) {
    console.error("sinij-konvert-api error", error);
    return fail("Не удалось выполнить запрос. Повторите попытку.", 500);
  }
});

