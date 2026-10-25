// 저장소 어댑터. config.js에 Supabase 값이 있으면 Supabase(RPC)에, 없으면 이 브라우저(localStorage)에 저장한다.
// 실서버에서는 참가자 브라우저가 테이블을 직접 읽지 못하고, 아래 3개의 RPC 함수만 호출할 수 있다. (supabase/schema.sql 참고)

const QUEUE_KEY = 'cfx_queue';
const LOCAL_KEY = 'cfx_local_v1';

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---------- Supabase ----------
function supabaseStore(cfg) {
  const base = cfg.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/';
  const headers = {
    'Content-Type': 'application/json',
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY,
  };
  async function rpc(name, body, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(base + name, { method: 'POST', headers, body: JSON.stringify(body), keepalive: true });
        if (!res.ok) throw new Error(name + ' ' + res.status + ' ' + (await res.text()));
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr;
  }
  // 실패한 쓰기는 큐에 쌓았다가 다음 호출 때 다시 보낸다 (참가자 화면은 막지 않는다).
  async function flush() {
    const q = readJSON(QUEUE_KEY, []);
    if (!q.length) return;
    const rest = [];
    for (const job of q) {
      try {
        await rpc(job.name, job.body, 1);
      } catch {
        rest.push(job);
      }
    }
    writeJSON(QUEUE_KEY, rest);
  }
  async function write(name, body) {
    try {
      await flush();
      await rpc(name, body);
      return true;
    } catch (e) {
      const q = readJSON(QUEUE_KEY, []);
      q.push({ name, body });
      writeJSON(QUEUE_KEY, q);
      console.warn('저장 실패, 대기열에 보관:', e.message);
      return false;
    }
  }
  return {
    kind: 'supabase',
    async startSession({ mode, pid, forceGroup, device }) {
      const r = await rpc('start_session', { p_mode: mode, p_pid: pid || null, p_force_group: forceGroup || null, p_device: device });
      return { id: r.id, group: r.grp };
    },
    savePart: (id, part, payload, status) => write('save_part', { p_id: id, p_part: part, p_payload: payload, p_status: status || null }),
    logEvents: (id, events) => (events.length ? write('log_events', { p_id: id, p_events: events }) : true),
    flush,
  };
}

// ---------- 로컬(테스트·오프라인 리허설) ----------
function localStore() {
  const load = () => readJSON(LOCAL_KEY, { sessions: {}, events: {} });
  const save = (d) => writeJSON(LOCAL_KEY, d);
  return {
    kind: 'local',
    async startSession({ mode, pid, forceGroup, device }) {
      const d = load();
      if (mode === 'lab' && pid) {
        // 연구 당일(stage=exp)에 사전 설문 때 만든 같은 pid의 세션을 이어서 쓴다
        const ex = Object.values(d.sessions).find((s) => s.mode === 'lab' && s.pid === pid);
        if (ex) {
          if (forceGroup) ex.grp = forceGroup;
          save(d);
          return { id: ex.id, group: ex.grp };
        }
      }
      const counts = { A: 0, B: 0, C: 0 };
      Object.values(d.sessions).forEach((s) => {
        if (s.mode === mode && s.status !== 'screened_out') counts[s.grp]++;
      });
      let grp = forceGroup;
      if (!grp) {
        const min = Math.min(...Object.values(counts));
        const pool = Object.keys(counts).filter((k) => counts[k] === min);
        grp = pool[Math.floor(Math.random() * pool.length)];
      }
      const id = uuid();
      const now = new Date().toISOString();
      d.sessions[id] = { id, created_at: now, updated_at: now, mode, pid: pid || null, grp, status: 'started', device };
      d.events[id] = [];
      save(d);
      return { id, group: grp };
    },
    async savePart(id, part, payload, status) {
      const d = load();
      const s = d.sessions[id];
      if (!s) return false;
      s[part] = payload;
      if (status) s.status = status;
      s.updated_at = new Date().toISOString();
      if (status === 'completed') s.completed_at = s.updated_at;
      save(d);
      return true;
    },
    async logEvents(id, events) {
      const d = load();
      (d.events[id] = d.events[id] || []).push(...events);
      save(d);
      return true;
    },
    async flush() {},
    exportAll() {
      const d = load();
      return {
        exported_at: new Date().toISOString(),
        sessions: Object.values(d.sessions),
        events: Object.entries(d.events).flatMap(([sid, evs]) => evs.map((e) => ({ session_id: sid, ...e }))),
      };
    },
    clear() {
      try {
        localStorage.removeItem(LOCAL_KEY);
      } catch {}
    },
  };
}

export function createStorage(cfg) {
  return cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY ? supabaseStore(cfg) : localStore();
}
