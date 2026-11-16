import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const DB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(DB_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const ORIGINS = new Set([
  "https://czbjcp2yqw-dot.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);
const TABLE = {
  members: "planner_v1_members",
  state: "planner_v1_state",
  bootstrap: "planner_v1_bootstrap",
  events: "planner_v1_events"
};
class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function errorIf(error: { message: string } | null, context: string): void {
  if (error) {
    console.error(context, error.message);
    throw new ApiError("Ошибка базы данных. Повторите попытку.", 500);
  }
}
function safeString(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}
function goodState(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.tasks) && Array.isArray(d.employees) && Array.isArray(d.equipment)
    && JSON.stringify(data).length < 1800000
    && d.tasks.length < 10000 && d.employees.length < 400;
}
function cors(origin: string | null): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    ...(origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}
function response(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), { status, headers: cors(origin) });
}
async function authenticatedUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new ApiError("Необходим вход в аккаунт.", 401);
  const jwt = authorization.slice(7).trim();
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user || data.user.is_anonymous === true)
    throw new ApiError("Войдите с подтверждённой электронной почтой.", 401);
  return data.user;
}
async function membership(userId: string) {
  const { data, error } = await admin.from(TABLE.members)
    .select("user_id,display_name,role,employee_id,active").eq("user_id", userId).maybeSingle();
  errorIf(error, "load member");
  return data;
}
async function currentState() {
  const { data, error } = await admin.from(TABLE.state)
    .select("data,revision").eq("id", 1).single();
  errorIf(error, "load state");
  if (!data) throw new ApiError("Состояние планировщика не найдено.", 500);
  return data;
}
function ensureEditor(member: any) {
  if (!member?.active || !["admin", "coordinator"].includes(member.role))
    throw new ApiError("У вас нет прав изменять план съёмок.", 403);
}
async function touch(revision: number) {
  const { error } = await admin.from(TABLE.events)
    .update({ revision, changed_at: new Date().toISOString() }).eq("id", 1);
  if (error) console.error("Planner notification", error.message);
}
async function processAction(action: string, body: Record<string, any>, user: any) {
  const member = await membership(user.id);
  if (action === "request") {
    if (member) return { profile: member };
    const name = safeString(body.display_name || user.email?.split("@")[0] || "Новый участник", 80);
    const { data, error } = await admin.from(TABLE.members).insert({
      user_id: user.id, display_name: name || "Новый участник",
      role: "operator", active: false, employee_id: null
    }).select("user_id,display_name,role,employee_id,active").single();
    if (error) {
      // Concurrent requests: read the inserted membership rather than changing privileges.
      const existing = await membership(user.id);
      if (existing) return { profile: existing };
      errorIf(error, "request access");
    }
    return { profile: data };
  }
  if (action === "claim") {
    if (member?.active) throw new ApiError("У вас уже есть доступ.", 409);
    const token = safeString(body.token, 128);
    if (!token) throw new ApiError("Введите одноразовый код владельца.");
    const bytes = new TextEncoder().encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    const { data: used, error } = await admin.from(TABLE.bootstrap)
      .update({ consumed: true, used_by: user.id })
      .eq("id", 1).eq("consumed", false).eq("token_hash", hash)
      .select("id");
    errorIf(error, "claim owner");
    if (!used?.length) throw new ApiError("Код неверный или уже использован.", 403);
    const { data, error: memberError } = await admin.from(TABLE.members).upsert({
      user_id: user.id, display_name: member?.display_name || safeString(user.email?.split("@")[0], 80) || "Владелец",
      role: "admin", active: true, employee_id: member?.employee_id || null,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" }).select("user_id,display_name,role,employee_id,active").single();
    errorIf(memberError, "create owner");
    return { profile: data, message: "Доступ администратора активирован." };
  }
  if (!member?.active) {
    if (action === "pull") return { profile: member, pending: true };
    throw new ApiError("Аккаунт ожидает подтверждения администратором.", 403);
  }
  if (action === "pull") {
    const saved = await currentState();
    const source = saved.data || { tasks: [], employees: [], equipment: [] };
    let shaped = source;
    if (member.role === "operator") {
      const ownId = Number(member.employee_id);
      shaped = {
        tasks: Array.isArray(source.tasks)
          ? source.tasks.filter((t: any) => ownId > 0 && Number(t.employeeId) === ownId)
          : [],
        employees: Array.isArray(source.employees)
          ? source.employees.filter((e: any) => ownId > 0 && Number(e.id) === ownId)
          : [],
        equipment: [],
        updatedAt: source.updatedAt || null
      };
    }
    let members: any[] = [];
    if (member.role === "admin") {
      const { data, error } = await admin.from(TABLE.members)
        .select("user_id,display_name,role,employee_id,active,created_at").order("created_at");
      errorIf(error, "list members");
      members = data || [];
    }
    return { profile: member, state: shaped, revision: Number(saved.revision), members };
  }
  if (action === "save") {
    ensureEditor(member);
    if (!goodState(body.data)) throw new ApiError("Некорректные данные или превышен размер плана.");
    const expected = Number(body.revision);
    if (!Number.isSafeInteger(expected) || expected < 1) throw new ApiError("Некорректная версия.");
    const { data, error } = await admin.from(TABLE.state).update({
      data: body.data, revision: expected + 1,
      updated_at: new Date().toISOString(), updated_by: user.id
    }).eq("id", 1).eq("revision", expected).select("revision").maybeSingle();
    errorIf(error, "save state");
    if (!data) throw new ApiError("План изменился у другого пользователя. Обновите данные и повторите действие.", 409);
    await touch(Number(data.revision));
    return { revision: Number(data.revision) };
  }
  if (action === "progress") {
    if (member.role !== "operator") throw new ApiError("Это действие доступно оператору.", 403);
    if (!member.employee_id) throw new ApiError("Администратор ещё не назначил ваш профиль сотруднику.", 403);
    const taskId = safeString(body.id, 80);
    const newStatus = safeString(body.status, 50);
    const stored = await currentState();
    const plan = stored.data;
    if (!goodState(plan)) throw new ApiError("Некорректное состояние плана.", 500);
    const tasks = plan.tasks as Array<any>;
    const index = tasks.findIndex(t => t.id === taskId);
    if (index < 0 || Number(tasks[index].employeeId) !== Number(member.employee_id))
      throw new ApiError("Съёмка не найдена среди ваших задач.", 403);
    const current = tasks[index].status;
    const transitions: Record<string, string> = {
      assigned: "confirmed", new: "confirmed", confirmed: "in_progress",
      in_progress: "filmed", filmed: "uploaded"
    };
    if (transitions[current] !== newStatus)
      throw new ApiError("Этот переход статуса сейчас недоступен.", 409);
    const updatedTask: any = { ...tasks[index], status: newStatus };
    if (newStatus === "uploaded") {
      const link = safeString(body.link, 2000);
      if (!/^https:\/\/[^ \t\n\r]+$/i.test(link)) throw new ApiError("Укажите HTTPS-ссылку на материалы.");
      updatedTask.link = link;
      updatedTask.note = safeString(body.note, 2000);
    }
    const next = { ...plan, tasks: tasks.map((t, i) => i === index ? updatedTask : t) };
    const expected = Number(stored.revision);
    const { data, error } = await admin.from(TABLE.state).update({
      data: next, revision: expected + 1,
      updated_at: new Date().toISOString(), updated_by: user.id
    }).eq("id", 1).eq("revision", expected).select("revision").maybeSingle();
    errorIf(error, "update progress");
    if (!data) throw new ApiError("Расписание обновилось. Повторите действие после синхронизации.", 409);
    await touch(Number(data.revision));
    return { revision: Number(data.revision) };
  }
  if (action === "manage") {
    if (member.role !== "admin") throw new ApiError("Только администратор управляет доступом.", 403);
    const userId = safeString(body.user_id, 40);
    const role = safeString(body.role, 30);
    const active = body.active === true;
    const employeeId = body.employee_id === null || body.employee_id === ""
      ? null : Number(body.employee_id);
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !["admin","coordinator","operator"].includes(role))
      throw new ApiError("Некорректные параметры доступа.");
    if (role === "operator" && active && (!Number.isSafeInteger(employeeId) || employeeId < 1))
      throw new ApiError("Для оператора необходимо выбрать сотрудника.");
    if (employeeId !== null && (!Number.isSafeInteger(employeeId) || employeeId < 1))
      throw new ApiError("Некорректный сотрудник.");
    if (userId === user.id && (!active || role !== "admin"))
      throw new ApiError("Нельзя отключить собственный доступ администратора.");
    const prev = await membership(userId);
    if (!prev) throw new ApiError("Пользователь не найден.", 404);
    if (role === "admin" && userId !== user.id)
      throw new ApiError("Передача прав администратора выполняется отдельно.", 403);
    if (employeeId !== null) {
      const st = await currentState();
      if (!(st.data?.employees || []).some((e: any) => Number(e.id) === employeeId))
        throw new ApiError("Сотрудник отсутствует в календаре.", 400);
    }
    const { data, error } = await admin.from(TABLE.members).update({
      role, active, employee_id: employeeId, updated_at: new Date().toISOString()
    }).eq("user_id", userId).select("user_id,display_name,role,employee_id,active").single();
    errorIf(error, "manage member");
    return { member: data };
  }
  throw new ApiError("Неизвестное действие.", 404);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && !ORIGINS.has(origin)) return response({ error: "Источник запроса не разрешён." }, 403, null);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return response({ error: "Только POST." }, 405, origin);
  try {
    const user = await authenticatedUser(req);
    let body;
    try { body = await req.json(); } catch { throw new ApiError("Неверный JSON."); }
    if (!body || typeof body !== "object") throw new ApiError("Некорректный запрос.");
    const result = await processAction(safeString(body.action, 40), body, user);
    return response(result, 200, origin);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 500) console.error("Planner edge failure", error);
    return response({ error: status === 500 ? "Внутренняя ошибка сервера." : String(error.message) }, status, origin);
  }
});
