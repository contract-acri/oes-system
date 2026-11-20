/**
 * ============================================================================
 *  ACRI ONLINE EXAMINATION SYSTEM  —  Code.gs
 *  Ahmedabad Centre for Research and Innovation
 * ----------------------------------------------------------------------------
 *  One backend for one site, www.oes.acriindia.org.in (GitHub → Cloudflare Pages):
 *    /          students sit exams                                  (index.html)
 *    /admin     Controller of Examinations                          (admin/index.html)
 *    /review    reviewers                                           (review/index.html)
 *    /control   Master Control: load, auto pause/resume, stress test (control/index.html)
 *    /papers    paper setters and moderators                        (papers/index.html)
 *
 *  Pages call this script with fetch POST (text/plain, JSON body) to /exec.
 *  All data lives in this Google Sheet. Proctoring images are saved to a
 *  Drive folder and logged in the "Snapshots" sheet. The near-live Proctor
 *  grid uses the script cache (latest frame per student).
 *  Email: Zoho Mail API (India DC) from controller.examination@pd.acriindia.org,
 *  with Gmail (MailApp) as the backup.
 * ============================================================================
 */

const CFG = {
  TZ: 'Asia/Kolkata',
  APP: 'ACRI Online Examinations',
  ORG: 'Ahmedabad Centre for Research and Innovation',
  FROM_EMAIL: 'controller.examination@pd.acriindia.org',
  FROM_NAME: 'Controller of Examinations, ACRI',
  ZOHO_ACCOUNTS: 'https://accounts.zoho.in',
  ZOHO_MAIL: 'https://mail.zoho.in',
  ZOHO_SCOPES: 'ZohoMail.messages.ALL,ZohoMail.accounts.READ',
  SESSION_SECONDS: 21600,     // staff login lasts 6 hours (cache maximum)
  GRACE_SECONDS: 180,         // late-network allowance after a student's deadline
  HASH_ROUNDS: 300
};

// Full ACRI logo, used inside result PDFs.
const LOGO_FULL = '__LOGO_FULL__';

const ST = {
  IP: 'In Progress', SUB: 'Submitted', UR: 'Under Review', SENT: 'Sent to CoE',
  RET: 'Returned', VER: 'Verified', RES: 'Result Sent', VOID: 'Voided'
};

// UGC 10-point letter grades (CBCS). Grade points and meanings are fixed;
// the minimum percentage for each grade is set per exam (defaults below).
const GRADES = [
  { g: 'O',  m: 'Outstanding',   gp: 10, min: 90 },
  { g: 'A+', m: 'Excellent',     gp: 9,  min: 80 },
  { g: 'A',  m: 'Very Good',     gp: 8,  min: 70 },
  { g: 'B+', m: 'Good',          gp: 7,  min: 60 },
  { g: 'B',  m: 'Above Average', gp: 6,  min: 55 },
  { g: 'C',  m: 'Average',       gp: 5,  min: 50 },
  { g: 'P',  m: 'Pass',          gp: 4,  min: 40 },
  { g: 'F',  m: 'Fail',          gp: 0,  min: 0 }
];

// Event types that count as proctoring warnings.
const VIOLATIONS = ['TAB_HIDDEN', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'SCREEN_SHARE_STOPPED', 'CAMERA_STOPPED'];

const SCHEMA = {
  Settings:  ['Key', 'Value', 'Notes'],
  Staff:     ['Email', 'Name', 'Role', 'Status', 'Designation', 'Phone', 'RequestedAt', 'ActivatedAt', 'LastLogin', 'PasswordHash', 'Salt', 'Notes'],
  Exams:     ['ExamID', 'Title', 'Description', 'Instructions', 'AccessCode', 'StartIST', 'EndIST', 'DurationMin', 'Status',
              'Reviewers', 'Camera', 'Screen', 'Fullscreen', 'LiveProctor', 'MaxWarnings', 'ShuffleQuestions', 'TotalMarks',
              'CourseCode', 'Credits', 'Programme', 'Semester', 'Session', 'RollPrefix', 'GradeBands', 'RegisteredOnly',
              'ExpectedCandidates', 'Priority', 'Hold', 'GroupID', 'Mode', 'Blueprint', 'Moderators', 'DrawnAt',
              'CreatedBy', 'CreatedAt', 'UpdatedAt'],
  Questions: ['QuestionID', 'ExamID', 'Order', 'Type', 'Question', 'Options', 'Correct', 'Marks', 'Section', 'Difficulty', 'PoolQID', 'ModelAnswer'],
  Attempts:  ['AttemptID', 'ExamID', 'RollNo', 'Name', 'Email', 'Status', 'StartedAt', 'Deadline', 'SubmittedAt', 'SubmitReason', 'Violations',
              'MCQScore', 'WrittenScore', 'TotalScore', 'MaxScore', 'Reviewer', 'ReviewerRemarks', 'SentToCoEAt', 'CoERemarks',
              'Percentage', 'Grade', 'GradePoint', 'CreditPoints', 'Result',
              'VerifiedBy', 'VerifiedAt', 'ResultSentAt', 'ResultNo', 'PausedAt', 'PausedReason', 'ResumeEta', 'PausedSecTotal', 'ExtendedMin', 'Notice',
              'UserAgent', 'Token'],
  Candidates: ['CandidateID', 'ExamID', 'RollNo', 'Name', 'Email', 'Phone', 'Programme', 'AdmitSentAt', 'AdmitNo', 'AddedBy', 'AddedAt'],
  Answers:   ['AttemptID', 'QuestionID', 'ExamID', 'Type', 'Answer', 'AutoMarks', 'AwardedMarks', 'MaxMarks', 'Comment'],
  Events:    ['Time', 'AttemptID', 'ExamID', 'Email', 'Type', 'Detail'],
  Snapshots: ['Time', 'AttemptID', 'ExamID', 'Email', 'Kind', 'Reason', 'FileID', 'FileURL'],
  MailLog:   ['Time', 'To', 'Subject', 'Via', 'Result'],
  AuditLog:  ['Time', 'Actor', 'Action', 'Target', 'Detail'],
  ControlLog: ['Time', 'Actor', 'Action', 'Scope', 'Detail'],
  Pool:      ['PoolQID', 'GroupID', 'Section', 'Type', 'Question', 'Options', 'Correct', 'Difficulty', 'Topic', 'ModelAnswer', 'SetterEmail', 'AssignID',
              'Status', 'ModNote', 'ModeratedBy', 'ModeratedAt', 'UsedBy', 'UsedAt', 'CreatedAt', 'UpdatedAt'],
  Assignments: ['AssignID', 'GroupID', 'SetterEmail', 'Section', 'Count', 'Due', 'Note', 'CreatedBy', 'CreatedAt'],
  Submissions: ['Time', 'AttemptID', 'ExamID', 'Email', 'Reason', 'Answers1', 'Answers2', 'Answers3', 'Answers4', 'Processed', 'ReceiptSent', 'Note']
};

const DEFAULT_SETTINGS = [
  ['ADMIN_EMAIL', '', 'Receives an email whenever someone requests a staff account'],
  ['FROM_EMAIL', CFG.FROM_EMAIL, 'Sender address. Must be the Zoho mailbox (or its alias) you connect'],
  ['FROM_NAME', CFG.FROM_NAME, 'Sender name used by the Gmail backup'],
  ['COE_NOTIFY_EMAIL', CFG.FROM_EMAIL, 'Receives an email when a reviewer sends marks to the CoE'],
  ['SNAPSHOT_SECONDS', '180', 'How often a routine camera/screen snapshot is stored (seconds). A snapshot is always taken at every warning'],
  ['LIVE_SECONDS', '8', 'Live Proctor refresh for the students on the grid page being watched (seconds)'],
  ['HEARTBEAT_SECONDS', '30', 'How often a writing student checks in (seconds). Answers are saved on the student’s computer all the time'],
  ['LIVE_PAGE_SIZE', '12', 'Students per page on the Live Proctor grid'],
  ['SEND_SUBMISSION_RECEIPT', 'Yes', 'Email students a receipt after they submit (Yes/No)'],
  ['LOGO_URL', '', 'Optional: public URL of the ACRI logo for email headers'],
  ['EXAM_SITE_URL', 'https://www.oes.acriindia.org.in', 'Student exam page'],
  ['COE_SITE_URL', 'https://www.oes.acriindia.org.in/admin', 'Controller of Examinations portal'],
  ['REVIEW_SITE_URL', 'https://www.oes.acriindia.org.in/review', 'Reviewer portal'],
  ['DRIVE_FOLDER_ID', '', 'Filled automatically: Drive folder holding proctoring snapshots'],
  ['CONTROL_SITE_URL', 'https://www.oes.acriindia.org.in/control', 'Master Control'],
  ['PAPERS_SITE_URL', 'https://www.oes.acriindia.org.in/papers', 'Paper setters and moderators'],
  ['CONTROL_MODE', 'Auto', 'Auto = the system pauses and resumes students by itself; Manual = only the CoE does'],
  ['CAPACITY_RPS', '', 'Filled by the stress test: requests per second the system sustained'],
  ['CAPACITY_TESTED_AT', '', 'Filled by the stress test'],
  ['CAPACITY_SAFETY', '80', 'Use this % of the measured capacity (safety margin)'],
  ['PAUSE_AT_PCT', '100', 'Auto-pause students when load passes this % of usable capacity'],
  ['TARGET_PCT', '85', 'Pause until load falls to this %; also the limit used when resuming'],
  ['RESUME_BELOW_PCT', '70', 'Start resuming paused students when load stays below this %'],
  ['RESUME_BUFFER_MIN', '2', 'Extra minutes added on resume, on top of the paused time'],
  ['SLOW_MS', '4000', 'If students see responses slower than this (ms), treat the system as overloaded']
];

/* =========================================================================
 *  WEB APP ENTRY POINTS
 * ========================================================================= */

const ROUTES = {
  // public / students
  ping: r_ping, examInfo: r_examInfo, startAttempt: r_startAttempt, tick: r_tick,
  logEvent: r_logEvent, snapshot: r_snapshot, submit: r_submit,
  // staff accounts
  requestAccount: r_requestAccount, login: r_login, logout: r_logout, me: r_me,
  // CoE
  listExams: r_listExams, getExam: r_getExam, saveExam: r_saveExam, setExamStatus: r_setExamStatus,
  deleteExam: r_deleteExam, listReviewers: r_listReviewers, coeQueue: r_coeQueue,
  verify: r_verify, sendBack: r_sendBack, sendResult: r_sendResult, voidAttempt: r_voidAttempt,
  listCandidates: r_listCandidates, addCandidates: r_addCandidates, deleteCandidate: r_deleteCandidate,
  admitCardPreview: r_admitCardPreview, setRegisteredOnly: r_setRegisteredOnly, sendAdmitCards: r_sendAdmitCards, gradeCardPreview: r_gradeCardPreview,
  // CoE + reviewers
  myExams: r_myExams, listAttempts: r_listAttempts, getAttempt: r_getAttempt, getSnapshots: r_getSnapshots,
  saveMarks: r_saveMarks, liveGrid: r_liveGrid,
  // Master Control + planning
  controlState: r_controlState, controlSettings: r_controlSettings, controlPriority: r_controlPriority, controlAction: r_controlAction,
  controlAttempts: r_controlAttempts, stressStart: r_stressStart, stressPing: r_stressPing, stressEnd: r_stressEnd,
  capacityPlan: r_capacityPlan, createBatches: r_createBatches,
  // Sealed papers
  poolStatus: r_poolStatus, assignSetter: r_assignSetter, removeAssignment: r_removeAssignment, poolUnseal: r_poolUnseal,
  setterTasks: r_setterTasks, setterSave: r_setterSave, setterDelete: r_setterDelete, setterSubmit: r_setterSubmit,
  modQueue: r_modQueue, modDecide: r_modDecide
};

function doGet() {
  return json_({ ok: true, app: CFG.APP, time: new Date().toISOString() });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request.' }); }
  const fn = ROUTES[req.action];
  if (!fn) return json_({ ok: false, error: 'Unknown action.' });
  const t0 = Date.now();
  let out, sysErr = false;
  try {
    out = fn(req) || {};
    out.ok = true;
    out.serverTime = Date.now();
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (!/^[A-Z_]+$/.test(msg) && msg.indexOf('USER:') !== 0) { sysErr = true; console.error(req.action, msg, err && err.stack); }
    out = { ok: false, error: msg.replace(/^USER:/, ''), serverTime: Date.now() };
  }
  metric_(req.action, Date.now() - t0, !sysErr, Number(req.lat) || 0, Number(req.fails) || 0);
  return json_(out);
}

/* =========================================================================
 *  STUDENT API
 * ========================================================================= */

function r_ping() { return { app: CFG.APP }; }

function r_examInfo(req) {
  const ex = examByCode_(req.code);
  if (!ex) fail_('That access code is not valid. Please check it with your invigilator.');
  const qs = cachedQuestions_(ex.ExamID);
  let qCount = qs.length, qMarks = qs.reduce((s, q) => s + (Number(q.Marks) || 0), 0);
  if (isPool_(ex) && !qs.length) {
    const p = groupParent_(groupId_(ex), examsAll_()), bp = parseBlueprint_(p && p.Blueprint);
    qCount = bp.sections.reduce((t, x) => t + x.count, 0); qMarks = blueprintTotal_(bp);
  }
  return {
    exam: {
      id: ex.ExamID, title: ex.Title, description: ex.Description, instructions: ex.Instructions,
      startIST: ist_(toDate_(ex.StartIST)), endIST: ist_(toDate_(ex.EndIST)),
      start: ms_(ex.StartIST), end: ms_(ex.EndIST), duration: Number(ex.DurationMin) || 0,
      state: examState_(ex), camera: yes_(ex.Camera), screen: yes_(ex.Screen),
      fullscreen: yes_(ex.Fullscreen), live: yes_(ex.LiveProctor), maxWarnings: Number(ex.MaxWarnings) || 0,
      registeredOnly: registeredOnly_(ex), courseCode: String(ex.CourseCode || ''),
      questionCount: qCount, totalMarks: qMarks
    }
  };
}

function r_startAttempt(req) {
  const name = String(req.name || '').trim().replace(/\s+/g, ' ');
  const email = lower_(req.email);
  if (name.length < 2) fail_('Please enter your full name.');
  if (!isEmail_(email)) fail_('Please enter a valid email address.');
  const ex = examByCode_(req.code);
  if (!ex) fail_('That access code is not valid.');
  const state = examState_(ex);
  if (state === 'off') fail_('This exam is not open right now.');
  if (state === 'upcoming') fail_('This exam has not started yet. It opens at ' + ist_(toDate_(ex.StartIST)) + ' IST.');
  if (state === 'closed') fail_('This exam closed at ' + ist_(toDate_(ex.EndIST)) + ' IST.');
  if (yes_(ex.Hold)) fail_('This exam is paused by the Controller of Examinations for a short while. Your time has not started. Please wait for your examiner’s instruction and try again.');
  let cand = null;
  if (registeredOnly_(ex)) {
    cand = cachedCandidates_(ex.ExamID)[email] || null;
    if (!cand) fail_('This email is not registered for this exam. Use the email address your admit card was sent to.');
  }
  const c = cache_();
  const ua = String(req.ua || '').slice(0, 300);

  // Short critical section: one-attempt check against a cached index, then an atomic append.
  const res = withLock_(() => {
    const now = new Date();
    const ix = attemptIndex_(ex.ExamID);
    const prevId = ix[email];
    if (prevId) {
      const prev = attemptRow_(prevId);
      if (prev && prev.Status !== ST.VOID) {
        const cached = JSON.parse(c.get('att_' + prevId) || '{}');
        const dl = toDate_(prev.Deadline);
        if (prev.Status === ST.IP && cached.status !== ST.SUB && dl && (now.getTime() < dl.getTime() || isPaused_(prev))) {
          const token = newToken_();
          update_('Attempts', prev._row, { Token: token, UserAgent: ua });
          prev.Token = token;
          return { att: prev, resumed: true };
        }
        fail_('You have already attempted this exam with ' + email + '. Only one attempt is allowed.');
      }
    }
    if (c.get('ctl_admit') === '0')
      fail_('The examination system is at full capacity right now. Your time has NOT started. Please wait 2–3 minutes and press Start again, or follow your examiner’s instructions.');
    if (isPool_(ex)) {
      const fresh = exam_(ex.ExamID);
      if (!toDate_(fresh.DrawnAt)) { drawPaper_(fresh); examsCacheClear_(); }
    }
    const end = toDate_(ex.EndIST);
    const dur = Number(ex.DurationMin) || 0;
    let deadline = end;
    if (dur > 0) deadline = new Date(Math.min(end.getTime(), now.getTime() + dur * 60000));
    const att = {
      AttemptID: id_('AT'), ExamID: ex.ExamID, RollNo: cand ? String(cand.RollNo) : '',
      Name: cand ? String(cand.Name) : name, Email: email, Status: ST.IP,
      StartedAt: now, Deadline: deadline, Violations: 0, Token: newToken_(), UserAgent: ua
    };
    append_('Attempts', att);
    ix[email] = att.AttemptID;
    putBig_('ix_' + ex.ExamID, JSON.stringify(ix), 21600);
    return { att: att, resumed: false };
  });

  const att = res.att, resumed = res.resumed;
  cacheAtt_(att);
  c.remove('ctl_sleep_until');
  if (resumed) c.put('viol_' + att.AttemptID, String(Number(att.Violations) || Number(c.get('viol_' + att.AttemptID)) || 0), 21600);
  else c.put('viol_' + att.AttemptID, '0', 21600);
  append_('Events', { Time: new Date(), AttemptID: att.AttemptID, ExamID: ex.ExamID, Email: email, Type: resumed ? 'RESUMED' : 'STARTED', Detail: resumed ? 'Attempt re-opened' : ua.slice(0, 200) });

  let qs = cachedQuestions_(ex.ExamID).map(q => ({
    id: q.QuestionID, type: q.Type === 'MCQ' ? 'MCQ' : 'Written', text: String(q.Question),
    options: q.Type === 'MCQ' ? parseOpts_(q.Options) : [], marks: Number(q.Marks) || 0
  }));
  if (yes_(ex.ShuffleQuestions)) qs = seededShuffle_(qs, att.AttemptID);
  let draft = {};
  if (resumed) { try { draft = JSON.parse(getBig_('draft_' + att.AttemptID) || '{}'); } catch (e) { draft = {}; } }
  const s = settings_();
  return Object.assign(pauseInfo_(attCacheObj_(att)), {
    attemptId: att.AttemptID, token: att.Token, resumed: resumed,
    deadline: toDate_(att.Deadline).getTime(), violations: Number(c.get('viol_' + att.AttemptID)) || 0,
    name: att.Name, email: att.Email, rollNo: String(att.RollNo || ''), questions: qs, draft: draft,
    liveSeconds: liveSec_(s), heartbeatSeconds: hbSec_(s), snapshotSeconds: snapSec_(s),
    exam: {
      id: ex.ExamID, title: ex.Title, camera: yes_(ex.Camera), screen: yes_(ex.Screen),
      fullscreen: yes_(ex.Fullscreen), live: yes_(ex.LiveProctor), maxWarnings: Number(ex.MaxWarnings) || 0
    }
  });
}

function r_tick(req) {
  const a = studentAuth_(req);
  const id = req.attemptId, c = cache_(), now = Date.now();
  if (a.status !== ST.IP) return { status: a.status };
  if (!a.paused && now > a.deadline + CFG.GRACE_SECONDS * 1000) {
    autoClose_(id, 'Auto-submitted by server: time over');
    return { status: ST.SUB };
  }
  const got = c.getAll(['w_' + id, 'viol_' + id]);
  const watched = !!got['w_' + id];
  const put = {};
  put['seen_' + id] = String(now);
  if (!a.paused && watched) {
    if (req.cam) put['lcam_' + id] = String(req.cam).slice(0, 99000);
    if (req.scr) put['lscr_' + id] = String(req.scr).slice(0, 99000);
    if (req.cam || req.scr) put['lt_' + id] = String(now);
  }
  c.putAll(put, 300);
  if (req.draft) putBig_('draft_' + id, JSON.stringify(req.draft), 21600);
  return Object.assign(pauseInfo_(a), { status: a.status, deadline: a.deadline, violations: Number(got['viol_' + id] || 0), watch: watched });
}

function pauseInfo_(a) {
  return {
    paused: !!a.paused, pausedAt: a.paused || 0, eta: a.eta || 0, remaining: a.paused ? Math.max(0, a.deadline - a.paused) : 0,
    pauseMessage: a.paused ? String(a.reason || '').replace(/^(Manual|Auto):?\s*/, '') : '', manual: /^Manual/.test(a.reason || ''),
    notice: a.notice || null
  };
}

function r_logEvent(req) {
  const a = studentAuth_(req);
  const id = req.attemptId, c = cache_();
  const type = String(req.type || 'INFO').toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 40) || 'INFO';
  append_('Events', { Time: new Date(), AttemptID: id, ExamID: a.examId, Email: a.email, Type: type, Detail: String(req.detail || '').slice(0, 500) });
  let v = Number(c.get('viol_' + id) || 0);
  if (VIOLATIONS.indexOf(type) >= 0 && a.status === ST.IP && !a.paused) {
    v++;
    c.put('viol_' + id, String(v), 21600);   // written to the sheet when the attempt is submitted
  }
  return { violations: v };
}

function r_snapshot(req) {
  const a = studentAuth_(req);
  if (a.status !== ST.IP || a.paused) return { saved: 0 };
  const folder = examFolder_(a.examId);
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd-HHmmss');
  const reason = String(req.reason || 'Periodic').slice(0, 120);
  const out = [];
  [['Camera', req.cam], ['Screen', req.scr]].forEach(([kind, data]) => {
    if (!data || String(data).indexOf('base64,') < 0) return;
    const bytes = Utilities.base64Decode(String(data).split('base64,')[1]);
    const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', `${req.attemptId}_${kind}_${stamp}.jpg`));
    out.push({ Time: new Date(), AttemptID: req.attemptId, ExamID: a.examId, Email: a.email, Kind: kind, Reason: reason, FileID: file.getId(), FileURL: file.getUrl() });
  });
  append_('Snapshots', out);
  return { saved: out.length };
}

/* ---- submissions: recorded instantly in a queue, written to the sheets in bulk every minute ---- */

function r_submit(req) {
  const a = studentAuth_(req);
  if (a.status !== ST.IP) return { status: a.status };
  const late = !a.paused && Date.now() > a.deadline + CFG.GRACE_SECONDS * 1000;
  let reason = String(req.reason || 'Submitted by student').slice(0, 120);
  if (late) reason += ' (received after deadline)';
  enqueueSubmission_(req.attemptId, a, req.answers || {}, reason);
  return { status: ST.SUB, attemptId: req.attemptId };
}

function enqueueSubmission_(id, a, answers, reason) {
  const json = JSON.stringify(answers || {});
  const parts = [0, 1, 2, 3].map(i => json.slice(i * 45000, (i + 1) * 45000));
  append_('Submissions', { Time: new Date(), AttemptID: id, ExamID: a.examId, Email: a.email, Reason: reason,
    Answers1: parts[0], Answers2: parts[1], Answers3: parts[2], Answers4: parts[3], Note: json.length > 180000 ? 'Answers longer than 180,000 characters were cut' : '' });
  a.status = ST.SUB;
  const c = cache_();
  c.put('att_' + id, JSON.stringify(a), 21600);
  c.put('subq', '1', 21600);
  c.removeAll(['lcam_' + id, 'lscr_' + id, 'lt_' + id, 'w_' + id]);
}

/** Every 5 minutes: queue attempts whose time ran out (browser closed, network lost). */
function closeExpiredAttempts() {
  const now = Date.now(), c = cache_();
  const live = rows_('Attempts').filter(a => a.Status === ST.IP && !isPaused_(a));
  const cached = live.length ? c.getAll(live.map(a => 'att_' + a.AttemptID)) : {};
  live.forEach(a => {
    const dl = toDate_(a.Deadline);
    const ca = cached['att_' + a.AttemptID] ? JSON.parse(cached['att_' + a.AttemptID]) : null;
    if (ca && (ca.status === ST.SUB || ca.paused)) return;
    if (dl && now > dl.getTime() + CFG.GRACE_SECONDS * 1000) {
      try { autoClose_(a.AttemptID, 'Auto-submitted by server: time over'); } catch (e) { console.error(e); }
    }
  });
  processSubmissions();
}

function autoClose_(id, reason) {
  const c = cache_();
  let a = null;
  try { a = JSON.parse(c.get('att_' + id) || 'null'); } catch (e) {}
  if (!a) { const row = attemptRow_(id); if (!row) return; a = attCacheObj_(row); }
  if (a.status !== ST.IP) return;
  let draft = {};
  try { draft = JSON.parse(getBig_('draft_' + id) || '{}'); } catch (e) { draft = {}; }
  enqueueSubmission_(id, a, draft, reason);
}

/** Trigger, every minute: write queued submissions to Answers / Attempts in bulk, then send receipts. */
function processSubmissions() {
  const c = cache_();
  if (!c.get('subq') || c.get('subq_running')) return;
  c.put('subq_running', '1', 330);
  try { processSubmissions_(); } finally { c.remove('subq_running'); }
}

function processSubmissions_() {
  const t0 = Date.now(), c = cache_();
  let sub = [], done = [];
  withLock_(() => {
    sub = rows_('Submissions');
    const todo = sub.filter(r => !r.Processed);
    if (!todo.length) { c.remove('subq'); return; }
    const all = rows_('Attempts'), byId = {};
    all.forEach(a => byId[a.AttemptID] = a);
    const qByExam = {};
    rows_('Questions').forEach(q => (qByExam[q.ExamID] = qByExam[q.ExamID] || []).push(q));
    Object.keys(qByExam).forEach(k => qByExam[k].sort((x, y) => (Number(x.Order) || 0) - (Number(y.Order) || 0)));
    const violKeys = todo.map(s => 'viol_' + s.AttemptID);
    const viol = c.getAll(violKeys);
    const ansRows = [], events = [], changed = [];
    todo.forEach(s => {
      s.Processed = new Date();
      const a = byId[s.AttemptID];
      if (!a) { s.Note = 'Attempt not found'; return; }
      if (a.Status !== ST.IP) { s.Note = (s.Note ? s.Note + '; ' : '') + 'Duplicate (already ' + a.Status + ')'; s.ReceiptSent = 'n/a'; return; }
      let answers = {};
      try { answers = JSON.parse(String(s.Answers1 || '') + String(s.Answers2 || '') + String(s.Answers3 || '') + String(s.Answers4 || '') || '{}'); } catch (e) { s.Note = 'Answers could not be read'; }
      const r = scoreAnswers_(a, qByExam[a.ExamID] || [], answers);
      r.rows.forEach(x => ansRows.push(x));
      Object.assign(a, { Status: ST.SUB, SubmittedAt: s.Time || new Date(), SubmitReason: s.Reason, Violations: Number(viol['viol_' + a.AttemptID] || a.Violations || 0),
        MCQScore: r.mcq, WrittenScore: '', TotalScore: r.mcq, MaxScore: r.max });
      changed.push(a); done.push({ s: s, a: a, q: (qByExam[a.ExamID] || []).length });
      events.push({ Time: new Date(), AttemptID: a.AttemptID, ExamID: a.ExamID, Email: a.Email, Type: 'SUBMITTED', Detail: s.Reason });
    });
    append_('Answers', ansRows);
    writeCols_('Attempts', all, ['Status', 'SubmittedAt', 'SubmitReason', 'Violations', 'MCQScore', 'WrittenScore', 'TotalScore', 'MaxScore']);
    writeCols_('Submissions', sub, ['Processed', 'Note', 'ReceiptSent']);
    append_('Events', events);
    const o = {};
    changed.forEach(a => o['att_' + a.AttemptID] = JSON.stringify(attCacheObj_(a)));
    if (changed.length) c.putAll(o, 21600);
    changed.forEach(a => delBig_('draft_' + a.AttemptID));
  });
  // Receipts (outside the lock, within this run's time budget; the rest go next minute).
  if (!yes_(setting_('SEND_SUBMISSION_RECEIPT'))) return;
  const pending = sub.filter(s => s.Processed && !s.ReceiptSent && !/Duplicate|not found/.test(String(s.Note || '')));
  if (!pending.length) return;
  const exams = {};
  examsAll_().forEach(e => exams[e.ExamID] = e);
  const attById = {};
  rows_('Attempts').forEach(a => attById[a.AttemptID] = a);
  let sent = 0;
  for (const s of pending) {
    if (Date.now() - t0 > 240000) { c.put('subq', '1', 21600); break; }
    const a = attById[s.AttemptID], ex = exams[s.ExamID];
    if (!a || !ex) { s.ReceiptSent = 'n/a'; continue; }
    try {
      sendMail_(a.Email, 'Submission received: ' + ex.Title, mailHtml_('Your answers have been received', `
        <p>Dear ${esc_(a.Name)},</p>
        <p>Your attempt for <b>${esc_(ex.Title)}</b> was submitted on ${ist_(toDate_(s.Time) || new Date())} IST.</p>
        <p>${a.RollNo ? 'Roll number: <b>' + esc_(a.RollNo) + '</b><br>' : ''}Attempt ID: <b>${esc_(a.AttemptID)}</b></p>
        <p>Your answers will now be reviewed. The Office of the Controller of Examinations will email your grade card once it is verified.</p>`));
      s.ReceiptSent = new Date(); sent++;
    } catch (e) { s.ReceiptSent = 'failed'; console.error('Receipt failed', e); }
  }
  if (sent || pending.some(s => s.ReceiptSent)) withLock_(() => {
    const fresh = rows_('Submissions'), map = {};
    pending.forEach(s => { if (s.ReceiptSent) map[s._row] = s.ReceiptSent; });
    fresh.forEach(r => { if (map[r._row] && !r.ReceiptSent) r.ReceiptSent = map[r._row]; });
    writeCols_('Submissions', fresh, ['ReceiptSent']);
  });
}

function scoreAnswers_(att, qs, answers) {
  let mcq = 0, max = 0;
  const rows = qs.map(q => {
    const m = Number(q.Marks) || 0;
    max += m;
    const v = answers[q.QuestionID];
    const base = { AttemptID: att.AttemptID, QuestionID: q.QuestionID, ExamID: att.ExamID, MaxMarks: m, Comment: '' };
    if (q.Type === 'MCQ') {
      const opts = parseOpts_(q.Options);
      let ans = '', auto = 0;
      if (v !== undefined && v !== null && v !== '') {
        const i = Number(v);
        if (i >= 0 && i < opts.length) { ans = (i + 1) + ') ' + opts[i]; if (i + 1 === Number(q.Correct)) auto = m; }
      }
      mcq += auto;
      return Object.assign(base, { Type: 'MCQ', Answer: ans, AutoMarks: auto, AwardedMarks: auto });
    }
    return Object.assign(base, { Type: 'Written', Answer: String(v == null ? '' : v), AutoMarks: '', AwardedMarks: '' });
  });
  return { rows: rows, mcq: mcq, max: max };
}

/* ---- caches that keep exam starts off the big sheets ---- */

function examsAll_() {
  const hit = getBig_('exams_all');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const list = rows_('Exams');
  putBig_('exams_all', JSON.stringify(list), 20);
  return list;
}
function examsCacheClear_() { try { delBig_('exams_all'); } catch (e) {} }

function cachedQuestions_(examId) {
  const hit = getBig_('qs_' + examId);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const qs = questions_(examId);
  putBig_('qs_' + examId, JSON.stringify(qs), 900);
  return qs;
}

function cachedCandidates_(examId) {
  const hit = getBig_('cands_' + examId);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const m = {};
  rows_('Candidates').filter(cd => cd.ExamID === examId).forEach(cd => m[lower_(cd.Email)] = { RollNo: String(cd.RollNo), Name: cd.Name });
  putBig_('cands_' + examId, JSON.stringify(m), 900);
  return m;
}

/** email → latest non-void AttemptID for an exam (call inside the lock). */
function attemptIndex_(examId) {
  const hit = getBig_('ix_' + examId);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const sh = sh_('Attempts'), lr = sh.getLastRow(), m = {};
  if (lr > 1) {
    const h = head_(sh), ci = h.indexOf('AttemptID'), ce = h.indexOf('ExamID'), cm = h.indexOf('Email'), cs = h.indexOf('Status');
    const w = Math.max(ci, ce, cm, cs) + 1;
    sh.getRange(2, 1, lr - 1, w).getValues().forEach(r => { if (r[ce] === examId && r[cs] !== ST.VOID) m[lower_(r[cm])] = r[ci]; });
  }
  putBig_('ix_' + examId, JSON.stringify(m), 21600);
  return m;
}

function hbSec_(s) { return Math.min(120, Math.max(15, Number((s || settings_()).HEARTBEAT_SECONDS) || 30)); }
function liveSec_(s) { return Math.min(30, Math.max(3, Number((s || settings_()).LIVE_SECONDS) || 8)); }
function snapSec_(s) { return Math.min(900, Math.max(30, Number((s || settings_()).SNAPSHOT_SECONDS) || 180)); }
function pageSize_(s) { return Math.min(30, Math.max(4, Number((s || settings_()).LIVE_PAGE_SIZE) || 12)); }


/* =========================================================================
 *  STAFF ACCOUNTS
 * ========================================================================= */

function r_requestAccount(req) {
  const email = lower_(req.email), name = String(req.name || '').trim(), pw = String(req.password || '');
  const role = (req.portal === 'coe' || req.portal === 'control') ? 'CoE' : req.portal === 'papers' ? 'Setter' : 'Reviewer';
  if (name.length < 2) fail_('Please enter your full name.');
  if (!isEmail_(email)) fail_('Please enter a valid email address.');
  if (pw.length < 8) fail_('Password must be at least 8 characters.');
  return withLock_(() => {
    const ex = staffRow_(email);
    if (ex) {
      const st = lower_(ex.Status);
      if (st === 'pending') fail_('A request for this email is already pending activation.');
      if (st === 'active') fail_('An account with this email already exists. Please sign in.');
      fail_('This email has an existing account (' + ex.Status + '). Please contact the Controller of Examinations.');
    }
    const salt = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid())).slice(0, 32);
    append_('Staff', {
      Email: email, Name: name, Role: role, Status: 'Pending', Designation: String(req.designation || '').slice(0, 120),
      Phone: String(req.phone || '').slice(0, 30), RequestedAt: new Date(), PasswordHash: hash_(pw, salt), Salt: salt
    });
    audit_(email, 'ACCOUNT_REQUESTED', email, role);
    const admin = setting_('ADMIN_EMAIL');
    if (admin) {
      try {
        sendMail_(admin, 'New ' + role + ' account request: ' + name, mailHtml_('New staff account request', `
          <p><b>${esc_(name)}</b> (${esc_(email)}) has requested a <b>${role}</b> account.</p>
          <p>Designation: ${esc_(req.designation || '—')}<br>Phone: ${esc_(req.phone || '—')}</p>
          <p>To approve, open the exam Google Sheet → <b>Staff</b> tab and change their Status from <b>Pending</b> to <b>Active</b>.</p>`));
      } catch (e) { console.error(e); }
    }
    return { message: 'Request submitted. You can sign in once your account is activated.' };
  });
}

function r_login(req) {
  const email = lower_(req.email), pw = String(req.password || '');
  const c = cache_(), fk = 'fail_' + email;
  const fails = Number(c.get(fk) || 0);
  if (fails >= 5) fail_('Too many failed attempts. Please try again in 15 minutes.');
  const r = staffRow_(email);
  if (!r || String(r.PasswordHash) !== hash_(pw, r.Salt)) {
    c.put(fk, String(fails + 1), 900);
    fail_('Incorrect email or password.');
  }
  const st = lower_(r.Status);
  if (st === 'pending') fail_('Your account request is still pending activation.');
  if (st !== 'active') fail_('Your account is ' + r.Status + '. Please contact the Controller of Examinations.');
  const role = normRole_(r.Role);
  if ((req.portal === 'coe' || req.portal === 'control') && role !== 'CoE') fail_('This account cannot use this portal. Reviewers use the reviewer portal; setters and moderators use the papers site.');
  if (req.portal === 'papers' && role !== 'Setter' && role !== 'Moderator') fail_('This site is for paper setters and moderators only.');
  if (req.portal === 'review' && (role === 'Setter' || role === 'Moderator')) fail_('Paper setters and moderators sign in on the papers site.');
  const token = newToken_() + newToken_();
  c.put('sess_' + token, JSON.stringify({ email: email }), CFG.SESSION_SECONDS);
  c.remove(fk);
  update_('Staff', r._row, { LastLogin: new Date() });
  return { token: token, user: { email: email, name: r.Name, role: role } };
}

function r_logout(req) { cache_().remove('sess_' + (req.token || '')); return {}; }
function r_me(req) { return { user: staff_(req) }; }

function staff_(req, roles) {
  const c = cache_();
  const s = c.get('sess_' + (req.token || ''));
  if (!s) fail_('SESSION_EXPIRED');
  const email = JSON.parse(s).email;
  const r = staffRow_(email);
  if (!r || lower_(r.Status) !== 'active') { c.remove('sess_' + req.token); fail_('SESSION_EXPIRED'); }
  const role = normRole_(r.Role);
  if (roles && roles.indexOf(role) < 0) fail_('You do not have permission for this action.');
  c.put('sess_' + req.token, s, CFG.SESSION_SECONDS);
  return { email: email, name: r.Name, role: role };
}

/* =========================================================================
 *  CoE: EXAMS
 * ========================================================================= */

function r_listExams(req) {
  const u = staff_(req, ['CoE']);
  const at = rows_('Attempts');
  const counts = countsByExam_(at);
  rows_('Candidates').forEach(c => { counts[c.ExamID] = counts[c.ExamID] || {}; counts[c.ExamID]._cand = (counts[c.ExamID]._cand || 0) + 1; });
  const allEx = rows_('Exams'), allPool = rows_('Pool'), covs = {};
  const exams = allEx.map(e => {
    const o = examOut_(e, counts[e.ExamID]);
    if (isPool_(e)) {
      const gid = groupId_(e);
      if (!(gid in covs)) covs[gid] = coverage_(gid, allEx, allPool.filter(q => String(q.GroupID) === gid));
      const c = covs[gid];
      if (c) o.pool = { ready: c.ready, have: c.cells.reduce((t, x) => t + Math.min(x.have, x.need), 0), need: c.cells.reduce((t, x) => t + x.need, 0), sets: c.sets, drawn: c.drawn };
    }
    return o;
  });
  exams.sort((a, b) => b.start - a.start);
  const pendingStaff = rows_('Staff').filter(s => lower_(s.Status) === 'pending').length;
  return {
    user: u, exams: exams,
    summary: {
      live: exams.filter(e => e.state === 'live').length,
      inProgress: at.filter(a => a.Status === ST.IP).length,
      toVerify: at.filter(a => a.Status === ST.SENT).length,
      toSend: at.filter(a => a.Status === ST.VER).length,
      pendingStaff: pendingStaff
    }
  };
}

function r_getExam(req) {
  staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const hasAttempts = rows_('Attempts').some(a => a.ExamID === ex.ExamID && a.Status !== ST.VOID);
  const sealed = isPool_(ex) && !toDate_(ex.DrawnAt);
  const gid = groupId_(ex), parent = isPool_(ex) ? groupParent_(gid) : null;
  return {
    exam: examOut_(ex), hasAttempts: hasAttempts,
    blueprint: parent ? parseBlueprint_(parent.Blueprint) : { sections: [] }, isParent: ex.ExamID === gid,
    parentTitle: parent ? parent.Title : '', parentId: gid,
    questions: sealed ? [] : questions_(ex.ExamID).map(q => ({
      id: q.QuestionID, type: q.Type === 'MCQ' ? 'MCQ' : 'Written', text: String(q.Question),
      options: parseOpts_(q.Options), correct: q.Type === 'MCQ' ? Number(q.Correct) - 1 : null, marks: Number(q.Marks) || 0
    }))
  };
}

function r_saveExam(req) {
  const u = staff_(req, ['CoE']);
  const e = req.exam || {}, qs = req.questions || [];
  const title = String(e.title || '').trim();
  if (!title) fail_('Please give the exam a title.');
  const code = String(e.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,24}$/.test(code)) fail_('Access code must be 4–24 letters, numbers or hyphens.');
  const start = toDate_(e.start), end = toDate_(e.end);
  if (!start || !end) fail_('Please set both start and end date/time.');
  if (end <= start) fail_('End time must be after start time.');
  const dur = Math.max(0, Math.round(Number(e.duration) || 0));
  if (e.live && !e.camera && !e.screen) fail_('Live Proctor needs camera or screen proctoring switched on.');
  const staffEmails = rows_('Staff').map(s => lower_(s.Email));
  const reviewers = uniq_((e.reviewers || []).map(lower_).filter(Boolean));
  const unknown = reviewers.filter(r => staffEmails.indexOf(r) < 0);
  if (unknown.length) fail_('These reviewers have no staff account yet: ' + unknown.join(', '));
  const mode = e.mode === 'Pool' ? 'Pool' : 'Direct';
  if (mode === 'Direct' && !qs.length) fail_('Add at least one question.');
  const credits = e.credits === '' || e.credits == null ? '' : Number(e.credits);
  if (credits !== '' && !(credits >= 0 && credits <= 40)) fail_('Credits must be a number between 0 and 40.');
  const bands = cleanBands_(e.bands);
  const rollPrefix = String(e.rollPrefix || '').trim().toUpperCase().replace(/[^A-Z0-9/-]/g, '');
  let total = 0;
  (mode === 'Direct' ? qs : []).forEach((q, i) => {
    const n = i + 1;
    if (!String(q.text || '').trim()) fail_('Question ' + n + ' is empty.');
    const m = Number(q.marks);
    if (!(m > 0)) fail_('Question ' + n + ' needs marks greater than 0.');
    total += m;
    if (q.type === 'MCQ') {
      const opts = (q.options || []).map(o => String(o).trim());
      if (opts.length < 2 || opts.some(o => !o)) fail_('Question ' + n + ' needs at least two filled options.');
      const ci = Number(q.correct);
      if (!(ci >= 0 && ci < opts.length)) fail_('Choose the correct option for question ' + n + '.');
    }
  });

  return withLock_(() => {
    const exams = rows_('Exams');
    const clash = exams.find(x => lower_(x.AccessCode) === lower_(code) && x.ExamID !== e.id);
    if (clash) fail_('Access code ' + code + ' is already used by "' + clash.Title + '".');
    let id = e.id;
    const cur = id ? exams.find(x => x.ExamID === id) : null;
    const gid = cur ? groupId_(cur) : '';
    const isParent = !cur || gid === cur.ExamID;
    const groupDrawn = cur ? groupExams_(gid, exams).some(x => toDate_(x.DrawnAt)) : false;
    if (cur && groupDrawn && (cur.Mode || 'Direct') !== mode) fail_('A paper has already been drawn for this exam, so the paper source cannot change.');
    let bpJson = '', mods = '';
    if (mode === 'Pool') {
      if (isParent) {
        const bp = cleanBlueprint_(e.blueprint);
        bpJson = JSON.stringify(bp);
        if (groupDrawn && cur && cur.Blueprint && cur.Blueprint !== bpJson) fail_('A paper has already been drawn from this blueprint, so it cannot change. All sessions must follow the same blueprint.');
        total = blueprintTotal_(bp);
        const st = rows_('Staff');
        mods = uniq_((e.moderators || []).map(lower_).filter(Boolean));
        const bad = mods.filter(m => !st.some(x => lower_(x.Email) === m && normRole_(x.Role) === 'Moderator'));
        if (bad.length) fail_('These are not moderator accounts: ' + bad.join(', '));
        mods = mods.join(', ');
      } else {
        const p = groupParent_(gid, exams);
        total = blueprintTotal_(parseBlueprint_(p && p.Blueprint));
      }
    }
    if (e.status === 'On' && mode === 'Pool' && cur && !toDate_(cur.DrawnAt)) {
      if (isParent) { const tmp = Object.assign({}, cur, { Blueprint: bpJson, Moderators: mods, Mode: 'Pool' }); requirePoolReady_(tmp, exams.map(x => x.ExamID === cur.ExamID ? tmp : x)); }
      else requirePoolReady_(cur, exams);
    }
    if (e.status === 'On' && mode === 'Pool' && !cur) fail_('Save the exam first, assign paper setters, and switch it On when the question pool is complete.');
    const obj = {
      Title: title, Description: String(e.description || ''), Instructions: String(e.instructions || ''),
      AccessCode: code, StartIST: start, EndIST: end, DurationMin: dur || '', Status: e.status === 'On' ? 'On' : 'Off',
      Reviewers: reviewers.join(', '), Camera: yn_(e.camera), Screen: yn_(e.screen), Fullscreen: yn_(e.fullscreen),
      LiveProctor: yn_(e.live), MaxWarnings: Math.max(0, Number(e.maxWarnings) || 0), ShuffleQuestions: yn_(e.shuffle),
      TotalMarks: total, CourseCode: String(e.courseCode || '').trim().toUpperCase(), Credits: credits,
      Programme: String(e.programme || '').trim(), Semester: String(e.semester || '').trim(), Session: String(e.session || '').trim(),
      RollPrefix: rollPrefix || ('ACRI' + Utilities.formatDate(new Date(), CFG.TZ, 'yy') + '-'),
      GradeBands: JSON.stringify(bands), RegisteredOnly: yn_(e.registeredOnly),
      ExpectedCandidates: Math.max(0, Math.round(Number(e.expected) || 0)) || '', Priority: PRIORITIES.indexOf(e.priority) >= 0 ? e.priority : 'Normal',
      Mode: mode, UpdatedAt: new Date()
    };
    if (mode === 'Pool' && isParent) { obj.Blueprint = bpJson; obj.Moderators = mods; }
    if (id) {
      const row = findRow_('Exams', 'ExamID', id);
      if (!row) fail_('Exam not found.');
      update_('Exams', row, obj);
    } else {
      id = id_('EX');
      append_('Exams', Object.assign(obj, { ExamID: id, GroupID: '', CreatedBy: u.email, CreatedAt: new Date() }));
    }
    if (mode === 'Pool') {
      if (!(cur && toDate_(cur.DrawnAt))) replaceRows_('Questions', r => r.ExamID !== id, []);   // a pool exam has no questions until its paper is drawn
      delBig_('qs_' + id);
      audit_(u.email, e.id ? 'EXAM_UPDATED' : 'EXAM_CREATED', id, title + ' (question pool)');
      cache_().remove('ctl_sleep_until');
      return { examId: id };
    }
    const newRows = qs.map((q, i) => ({
      QuestionID: q.id || id_('Q'), ExamID: id, Order: i + 1, Type: q.type === 'MCQ' ? 'MCQ' : 'Written',
      Question: String(q.text).trim(),
      Options: q.type === 'MCQ' ? JSON.stringify((q.options || []).map(o => String(o).trim())) : '',
      Correct: q.type === 'MCQ' ? Number(q.correct) + 1 : '', Marks: Number(q.marks)
    }));
    replaceRows_('Questions', r => r.ExamID !== id, newRows);
    delBig_('qs_' + id);
    audit_(u.email, e.id ? 'EXAM_UPDATED' : 'EXAM_CREATED', id, title);
    cache_().remove('ctl_sleep_until');
    return { examId: id };
  });
}

function r_setExamStatus(req) {
  const u = staff_(req, ['CoE']);
  const row = findRow_('Exams', 'ExamID', req.examId);
  if (!row) fail_('Exam not found.');
  const status = req.status === 'On' ? 'On' : 'Off';
  if (status === 'On') { const ex = rowObj_('Exams', row); if (!toDate_(ex.DrawnAt)) requirePoolReady_(ex); }
  update_('Exams', row, { Status: status, UpdatedAt: new Date() });
  audit_(u.email, 'EXAM_STATUS', req.examId, status);
  cache_().remove('ctl_sleep_until');
  return { status: status };
}

function r_deleteExam(req) {
  const u = staff_(req, ['CoE']);
  return withLock_(() => {
    if (rows_('Attempts').some(a => a.ExamID === req.examId && a.Status !== ST.VOID))
      fail_('This exam has attempts, so it cannot be deleted. Switch it Off instead.');
    const row = findRow_('Exams', 'ExamID', req.examId);
    if (!row) fail_('Exam not found.');
    const exd = rowObj_('Exams', row);
    if (isPool_(exd)) {
      const kids = groupExams_(groupId_(exd)).filter(x => x.ExamID !== exd.ExamID);
      if (groupId_(exd) === exd.ExamID && kids.length) fail_('Delete the other batches of this exam first. Batch 1 holds the question pool.');
      if (toDate_(exd.DrawnAt)) fail_('A paper has been drawn for this exam, so it cannot be deleted. Switch it Off instead.');
      if (groupId_(exd) === exd.ExamID) { replaceRows_('Pool', r => String(r.GroupID) !== exd.ExamID, []); replaceRows_('Assignments', r => String(r.GroupID) !== exd.ExamID, []); }
    }
    sh_('Exams').deleteRow(row);
    examsCacheClear_(); delBig_('qs_' + req.examId); delBig_('cands_' + req.examId);
    replaceRows_('Questions', r => r.ExamID !== req.examId, []);
    replaceRows_('Candidates', r => r.ExamID !== req.examId, []);
    audit_(u.email, 'EXAM_DELETED', req.examId, '');
    return {};
  });
}

function r_listReviewers(req) {
  staff_(req, ['CoE']);
  return {
    reviewers: rows_('Staff').filter(s => lower_(s.Status) === 'active')
      .map(s => ({ email: lower_(s.Email), name: s.Name, role: normRole_(s.Role) }))
  };
}

/* =========================================================================
 *  CoE + REVIEWERS: ATTEMPTS AND MARKING
 * ========================================================================= */

function r_myExams(req) {
  const u = staff_(req, ['CoE', 'Reviewer']);
  const counts = countsByExam_(rows_('Attempts'));
  const exams = rows_('Exams').filter(e => reviewersOf_(e).indexOf(u.email) >= 0).map(e => examOut_(e, counts[e.ExamID]));
  exams.sort((a, b) => b.start - a.start);
  return { user: u, exams: exams };
}

function r_listAttempts(req) {
  const u = staff_(req, ['CoE', 'Reviewer']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  access_(u, ex);
  const list = rows_('Attempts').filter(a => a.ExamID === ex.ExamID);
  const ip = list.filter(a => a.Status === ST.IP);
  const v = ip.length ? cache_().getAll(ip.map(a => 'viol_' + a.AttemptID)) : {};
  ip.forEach(a => { if (v['viol_' + a.AttemptID]) a.Violations = Number(v['viol_' + a.AttemptID]); });
  return { exam: examOut_(ex), attempts: list.map(attOut_) };
}

function r_coeQueue(req) {
  staff_(req, ['CoE']);
  const titles = {};
  rows_('Exams').forEach(e => titles[e.ExamID] = e.Title);
  return {
    attempts: rows_('Attempts').filter(a => a.Status === ST.SENT || a.Status === ST.VER || a.Status === ST.RET)
      .map(a => Object.assign(attOut_(a), { examTitle: titles[a.ExamID] || a.ExamID }))
  };
}

function r_getAttempt(req) {
  const u = staff_(req, ['CoE', 'Reviewer']);
  const att = attemptRow_(req.attemptId);
  if (!att) fail_('Attempt not found.');
  const ex = exam_(att.ExamID);
  access_(u, ex);
  markGate_(u, ex);
  const ans = {};
  answerRows_(att.AttemptID).forEach(a => ans[a.QuestionID] = a);
  return {
    attempt: attOut_(att), exam: examOut_(ex),
    questions: questions_(ex.ExamID).map(q => {
      const a = ans[q.QuestionID] || {};
      return {
        id: q.QuestionID, type: q.Type === 'MCQ' ? 'MCQ' : 'Written', text: String(q.Question),
        options: parseOpts_(q.Options), correct: q.Type === 'MCQ' ? Number(q.Correct) - 1 : null,
        marks: Number(q.Marks) || 0, answer: a.Answer === undefined ? '' : String(a.Answer),
        auto: a.AutoMarks, awarded: a.AwardedMarks === undefined ? '' : a.AwardedMarks, comment: a.Comment || '',
        recorded: !!a.QuestionID, section: String(q.Section || ''), modelAnswer: String(q.ModelAnswer || '')
      };
    }),
    events: rows_('Events').filter(e => e.AttemptID === att.AttemptID)
      .map(e => ({ time: ist_(toDate_(e.Time), 'dd MMM, hh:mm:ss a'), type: e.Type, detail: e.Detail })),
    snapshots: rows_('Snapshots').filter(s => s.AttemptID === att.AttemptID)
      .map(s => ({ time: ist_(toDate_(s.Time), 'hh:mm:ss a'), kind: s.Kind, reason: s.Reason, fileId: s.FileID }))
  };
}

function r_getSnapshots(req) {
  const u = staff_(req, ['CoE', 'Reviewer']);
  const ids = (req.fileIds || []).slice(0, 12);
  const known = {};
  rows_('Snapshots').forEach(s => { if (ids.indexOf(s.FileID) >= 0) known[s.FileID] = s.ExamID; });
  const examCache = {}, images = {};
  ids.forEach(fid => {
    const exId = known[fid];
    if (!exId) return;
    if (!(exId in examCache)) { try { access_(u, exam_(exId)); examCache[exId] = true; } catch (e) { examCache[exId] = false; } }
    if (!examCache[exId]) return;
    try { images[fid] = 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(fid).getBlob().getBytes()); }
    catch (e) { images[fid] = ''; }
  });
  return { images: images };
}

function r_saveMarks(req) {
  const u = staff_(req, ['CoE', 'Reviewer']);
  return withLock_(() => {
    const att = attemptRow_(req.attemptId);
    if (!att) fail_('Attempt not found.');
    const ex = exam_(att.ExamID);
    const isCoE = u.role === 'CoE';
    const assigned = reviewersOf_(ex).indexOf(u.email) >= 0;
    if (!isCoE && !assigned) fail_('This exam is not assigned to you.');
    markGate_(u, ex);
    const reviewerMode = !isCoE || (req.asReviewer && assigned);
    const allowed = reviewerMode ? [ST.SUB, ST.UR, ST.RET] : [ST.SUB, ST.UR, ST.RET, ST.SENT, ST.VER];
    if (allowed.indexOf(att.Status) < 0) fail_('This attempt is "' + att.Status + '" and cannot be edited now.');

    const marks = req.marks || {};
    let mcq = 0, wr = 0, missing = 0;
    answerRows_(att.AttemptID).forEach(a => {
      let aw = a.AwardedMarks, cm = a.Comment;
      const m = marks[a.QuestionID];
      if (m) {
        if (m.awarded === '' || m.awarded === null || m.awarded === undefined) aw = '';
        else {
          const n = Number(m.awarded), max = Number(a.MaxMarks) || 0;
          if (isNaN(n) || n < 0 || n > max) fail_('Marks must be between 0 and ' + max + ' for each question.');
          aw = n;
        }
        cm = String(m.comment || '').slice(0, 2000);
        update_('Answers', a._row, { AwardedMarks: aw, Comment: cm });
      }
      if (aw === '' || aw === null) missing++;
      else if (a.Type === 'MCQ') mcq += Number(aw);
      else wr += Number(aw);
    });
    const send = !!req.send;
    if (send && missing) fail_(missing + ' question(s) still need marks.');
    const patch = { MCQScore: mcq, WrittenScore: wr, TotalScore: mcq + wr };
    if (reviewerMode) {
      patch.Reviewer = u.email;
      patch.ReviewerRemarks = String(req.remarks || '').slice(0, 3000);
      patch.Status = send ? ST.SENT : ST.UR;
      if (send) patch.SentToCoEAt = new Date();
    } else if (req.remarks !== undefined) {
      patch.CoERemarks = String(req.remarks).slice(0, 3000);
    }
    update_('Attempts', att._row, patch);
    audit_(u.email, send ? 'SENT_TO_COE' : 'MARKS_SAVED', att.AttemptID, 'Total ' + (mcq + wr));
    if (send) {
      const to = setting_('COE_NOTIFY_EMAIL');
      if (to) {
        try {
          sendMail_(to, 'Marks ready for verification: ' + ex.Title, mailHtml_('An attempt is ready for verification', `
            <p>${esc_(u.name)} (${esc_(u.email)}) has sent marks to the CoE.</p>
            <p>Exam: <b>${esc_(ex.Title)}</b><br>Student: ${esc_(att.Name)} (${esc_(att.Email)})<br>
            Attempt ID: ${esc_(att.AttemptID)}<br>Total: <b>${mcq + wr}</b> / ${att.MaxScore}</p>
            <p>Open the CoE portal to verify: ${esc_(setting_('COE_SITE_URL'))}</p>`));
        } catch (e) { console.error(e); }
      }
    }
    return { status: patch.Status || att.Status, total: mcq + wr, missing: missing };
  });
}

function r_verify(req) {
  const u = staff_(req, ['CoE']);
  return withLock_(() => {
    const att = attemptRow_(req.attemptId);
    if (!att) fail_('Attempt not found.');
    if ([ST.SENT, ST.SUB, ST.UR, ST.RET].indexOf(att.Status) < 0) fail_('This attempt is "' + att.Status + '" and cannot be verified.');
    let total = 0, missing = 0;
    answerRows_(att.AttemptID).forEach(a => {
      if (a.AwardedMarks === '' || a.AwardedMarks === null) missing++; else total += Number(a.AwardedMarks);
    });
    if (missing) fail_(missing + ' question(s) have no marks yet.');
    const ex = exam_(att.ExamID);
    const gr = grade_(ex, total, Number(att.MaxScore) || totalMax_(ex.ExamID));
    update_('Attempts', att._row, {
      Status: ST.VER, VerifiedBy: u.email, VerifiedAt: new Date(), TotalScore: total,
      Percentage: gr.pct, Grade: gr.grade, GradePoint: gr.gp, CreditPoints: gr.cp, Result: gr.result,
      CoERemarks: req.remarks !== undefined ? String(req.remarks).slice(0, 3000) : att.CoERemarks
    });
    audit_(u.email, 'VERIFIED', att.AttemptID, 'Total ' + total + ', grade ' + gr.grade);
    return { status: ST.VER, grade: gr };
  });
}

function r_sendBack(req) {
  const u = staff_(req, ['CoE']);
  const remarks = String(req.remarks || '').trim();
  if (!remarks) fail_('Please write a note for the reviewer explaining what to change.');
  return withLock_(() => {
    const att = attemptRow_(req.attemptId);
    if (!att) fail_('Attempt not found.');
    if ([ST.SENT, ST.VER].indexOf(att.Status) < 0) fail_('Only attempts sent to the CoE can be returned.');
    const ex = exam_(att.ExamID);
    update_('Attempts', att._row, { Status: ST.RET, CoERemarks: remarks.slice(0, 3000), VerifiedBy: '', VerifiedAt: '' });
    audit_(u.email, 'RETURNED', att.AttemptID, remarks.slice(0, 200));
    const to = att.Reviewer || reviewersOf_(ex).join(',');
    if (to) {
      try {
        sendMail_(to, 'Returned for revision: ' + ex.Title + ' — ' + att.Name, mailHtml_('An attempt was returned to you', `
          <p>The Controller of Examinations has returned an attempt for revision.</p>
          <p>Exam: <b>${esc_(ex.Title)}</b><br>Student: ${esc_(att.Name)}<br>Attempt ID: ${esc_(att.AttemptID)}</p>
          <p style="background:#f4f8f5;border-left:4px solid #63B72D;padding:10px 14px">${esc_(remarks).replace(/\n/g, '<br>')}</p>
          <p>Open the reviewer portal: ${esc_(setting_('REVIEW_SITE_URL'))}</p>`));
      } catch (e) { console.error(e); }
    }
    return { status: ST.RET };
  });
}

function r_sendResult(req) {
  const u = staff_(req, ['CoE']);
  const att = attemptRow_(req.attemptId);
  if (!att) fail_('Attempt not found.');
  if ([ST.VER, ST.RES].indexOf(att.Status) < 0) fail_('Verify this attempt before sending the result.');
  const ex = exam_(att.ExamID);
  const gr = grade_(ex, Number(att.TotalScore) || 0, Number(att.MaxScore) || 0);
  if (!att.ResultNo) { att.ResultNo = docNo_('GC', ex, att.AttemptID); update_('Attempts', att._row, { ResultNo: att.ResultNo }); }
  const pdf = gradeCardPdf_(att, ex);
  const via = sendMail_(att.Email, 'Grade card: ' + ex.Title, mailHtml_('Your grade card is ready', `
      <p>Dear ${esc_(att.Name)},</p>
      <p>The result of <b>${esc_(ex.Title)}</b>${ex.CourseCode ? ' (' + esc_(ex.CourseCode) + ')' : ''} has been verified by the Office of the Controller of Examinations.</p>
      <table style="border-collapse:collapse;margin:10px 0">
        ${att.RollNo ? `<tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Roll number</td><td><b>${esc_(att.RollNo)}</b></td></tr>` : ''}
        <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Marks</td><td><b>${att.TotalScore} / ${att.MaxScore}</b> (${gr.pct}%)</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Letter grade</td><td><b>${gr.grade}</b> — ${gr.meaning} · Grade point ${gr.gp}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Result</td><td><b style="color:${gr.result === 'Pass' ? '#4C9420' : '#C8372D'}">${gr.result}</b></td></tr>
      </table>
      <p>Your grade card is attached as a PDF (No. ${esc_(att.ResultNo)}).</p>`), [pdf]);
  update_('Attempts', att._row, { Status: ST.RES, ResultSentAt: new Date(), Percentage: gr.pct, Grade: gr.grade, GradePoint: gr.gp, CreditPoints: gr.cp, Result: gr.result });
  audit_(u.email, 'RESULT_SENT', att.AttemptID, via);
  return { status: ST.RES, via: via };
}

/** CoE preview of the grade card PDF before sending. */
function r_gradeCardPreview(req) {
  staff_(req, ['CoE']);
  const att = attemptRow_(req.attemptId);
  if (!att) fail_('Attempt not found.');
  const ex = exam_(att.ExamID);
  if (!att.ResultNo) att.ResultNo = '(assigned when sent)';
  let total = 0;
  answerRows_(att.AttemptID).forEach(a => { if (a.AwardedMarks !== '') total += Number(a.AwardedMarks) || 0; });
  att.TotalScore = total;
  const pdf = gradeCardPdf_(att, ex, true);
  return { pdf: Utilities.base64Encode(pdf.getBytes()), name: pdf.getName() };
}

function r_voidAttempt(req) {
  const u = staff_(req, ['CoE']);
  return withLock_(() => {
    const att = attemptRow_(req.attemptId);
    if (!att) fail_('Attempt not found.');
    update_('Attempts', att._row, { Status: ST.VOID, CoERemarks: String(req.remarks || 'Voided by CoE').slice(0, 3000) });
    att.Status = ST.VOID;
    delBig_('ix_' + att.ExamID);
    cacheAtt_(att);
    audit_(u.email, 'VOIDED', att.AttemptID, String(req.remarks || ''));
    return { status: ST.VOID };
  });
}

function r_liveGrid(req) {
  const u = staff_(req, ['CoE', 'Reviewer']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  access_(u, ex);
  if (!yes_(ex.LiveProctor)) fail_('Live Proctor is not switched on for this exam.');
  const s = settings_(), per = pageSize_(s), c = cache_(), now = Date.now(), hb = hbSec_(s);
  let atts = rows_('Attempts').filter(a => a.ExamID === ex.ExamID && a.Status === ST.IP);
  const ca = atts.length ? c.getAll(atts.map(a => 'att_' + a.AttemptID)) : {};
  atts = atts.filter(a => { try { return JSON.parse(ca['att_' + a.AttemptID] || '{}').status !== ST.SUB; } catch (e) { return true; } });
  atts.sort((x, y) => String(x.Name).localeCompare(String(y.Name)));
  const pages = Math.max(1, Math.ceil(atts.length / per));
  const page = Math.min(pages, Math.max(1, Math.round(Number(req.page) || 1)));
  const shown = atts.slice((page - 1) * per, page * per);
  const zoom = req.zoom && atts.find(a => a.AttemptID === req.zoom && shown.indexOf(a) < 0);
  const watch = shown.concat(zoom ? [zoom] : []);
  // Only the students being looked at send live frames.
  if (watch.length) { const w = {}; watch.forEach(a => w['w_' + a.AttemptID] = '1'); c.putAll(w, 25); }
  let wl = {};
  try { wl = JSON.parse(c.get('wl_' + ex.ExamID) || '{}'); } catch (e) {}
  Object.keys(wl).forEach(k => { if (now - wl[k].t > 30000) delete wl[k]; });
  wl[String(req.token || '').slice(0, 10) || 'x'] = { n: watch.length, t: now };
  c.put('wl_' + ex.ExamID, JSON.stringify(wl), 120);
  const keys = [];
  watch.forEach(a => ['lcam_', 'lscr_', 'lt_'].forEach(p => keys.push(p + a.AttemptID)));
  atts.forEach(a => keys.push('seen_' + a.AttemptID, 'viol_' + a.AttemptID));
  const g = keys.length ? c.getAll(keys) : {};
  const seenAge = a => (now - Number(g['seen_' + a.AttemptID] || 0)) / 1000;
  return {
    exam: { id: ex.ExamID, title: ex.Title, state: examState_(ex), camera: yes_(ex.Camera), screen: yes_(ex.Screen) },
    page: page, pages: pages, total: atts.length, perPage: per, liveSeconds: liveSec_(s), heartbeatSeconds: hb,
    summary: { paused: atts.filter(isPaused_).length, noSignal: atts.filter(a => seenAge(a) > 2 * hb + 20).length, warned: atts.filter(a => Number(g['viol_' + a.AttemptID] || 0) > 0).length },
    students: watch.map(a => {
      const id = a.AttemptID;
      return {
        id: id, name: a.Name, email: a.Email, rollNo: String(a.RollNo || ''), cam: g['lcam_' + id] || '', scr: g['lscr_' + id] || '',
        frameAt: Number(g['lt_' + id] || 0), seenAt: Number(g['seen_' + id] || 0),
        violations: Number(g['viol_' + id] || a.Violations || 0), deadline: ms_(a.Deadline), paused: isPaused_(a), zoomOnly: a === zoom
      };
    })
  };
}

/* =========================================================================
 *  GRADING — UGC 10-point letter grades (CBCS)
 * ========================================================================= */

/** Minimum % per grade for an exam (saved JSON, falling back to the defaults in GRADES). */
function bands_(ex) {
  let saved = {};
  try { saved = JSON.parse(String((ex && ex.GradeBands) || '{}')) || {}; } catch (e) { saved = {}; }
  const o = {};
  GRADES.forEach(g => { const v = saved[g.g]; o[g.g] = (v !== undefined && v !== '' && !isNaN(Number(v))) ? Number(v) : g.min; });
  o.F = 0;
  return o;
}

function cleanBands_(b) {
  b = b || {};
  const o = {};
  let prev = 100.01;
  GRADES.forEach(g => {
    if (g.g === 'F') { o.F = 0; return; }
    const raw = b[g.g];
    const v = Number(raw === undefined || raw === '' || raw === null ? g.min : raw);
    if (isNaN(v) || v <= 0 || v > 100) fail_('Minimum % for grade ' + g.g + ' must be between 1 and 100.');
    if (v >= prev) fail_('Grade cut-offs must go down from O to P, each lower than the one above.');
    o[g.g] = Math.round(v * 100) / 100;
    prev = v;
  });
  return o;
}

function grade_(ex, total, max) {
  const b = bands_(ex);
  const pct = max ? Math.round(Number(total) / Number(max) * 10000) / 100 : 0;
  const g = GRADES.find(x => pct >= b[x.g]) || GRADES[GRADES.length - 1];
  const credits = ex && ex.Credits !== '' && ex.Credits != null ? (Number(ex.Credits) || 0) : 0;
  return {
    pct: pct, grade: g.g, meaning: g.m, gp: g.gp, credits: credits,
    cp: credits ? Math.round(g.gp * credits * 100) / 100 : '', result: g.g === 'F' ? 'Fail' : 'Pass', passMark: b.P
  };
}

function bandRows_(ex) {
  const b = bands_(ex);
  return GRADES.map((g, i) => {
    const upper = i === 0 ? null : b[GRADES[i - 1].g];
    const range = i === 0 ? b[g.g] + '% and above' : (g.g === 'F' ? 'Below ' + upper + '%' : b[g.g] + '% to below ' + upper + '%');
    return { g: g.g, m: g.m, gp: g.gp, range: range };
  });
}

function totalMax_(examId) { return questions_(examId).reduce((s, q) => s + (Number(q.Marks) || 0), 0); }
function registeredOnly_(ex) { return yes_(ex && ex.RegisteredOnly); }
function docNo_(prefix, ex, id) {
  return 'ACRI/' + prefix + '/' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyy') + '/' + String(id).replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase();
}
function verifyCode_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'ACRI|' + s + '|' + ss_().getId())).slice(0, 10).toUpperCase();
}

/* =========================================================================
 *  PDF DOCUMENTS — grade card and admit card
 * ========================================================================= */

function pdfCss_() {
  return `<style>
    @page{size:A4;margin:12mm 13mm}
    body{font-family:Arial,Helvetica,sans-serif;color:#1b2733;font-size:10.5px;margin:0}
    table{font-size:10px;font-family:Arial,Helvetica,sans-serif}
    .frame{border:1.5px solid #166FB1;padding:14px 18px 12px;position:relative}
    .band{height:5px;background:#166FB1;margin:-14px -18px 12px}
    .band2{height:3px;background:#63B72D;margin:-12px -18px 12px}
    .hd{width:100%;border-collapse:collapse}
    .hd td{vertical-align:middle}
    .hd img{height:86px}
    .office{font-size:9.5px;letter-spacing:2px;color:#166FB1;font-weight:bold;text-transform:uppercase}
    h1{font-size:19px;color:#0B2E4F;margin:4px 0 2px;letter-spacing:3px}
    .sess{font-size:10.5px;color:#4C9420;font-weight:bold}
    .no{font-size:9.5px;color:#5d6b7a;text-align:right;line-height:1.6}
    .no b{color:#0B2E4F}
    table.k{width:100%;border-collapse:collapse;margin-top:10px}
    table.k td{border:1px solid #cfdcd5;padding:5px 7px}
    table.k td.l{background:#f1f6f3;color:#5d6b7a;width:17%;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px}
    table.k td.v{font-weight:bold;color:#0B2E4F}
    table.g{width:100%;border-collapse:collapse;margin-top:12px}
    table.g th{background:#0B2E4F;color:#fff;padding:6px 5px;font-size:9px;text-transform:uppercase;letter-spacing:.4px;text-align:center}
    table.g td{border:1px solid #cfdcd5;padding:6px 5px;text-align:center}
    table.g td.t{text-align:left}
    .sec{margin-top:14px;font-size:10px;font-weight:bold;color:#166FB1;text-transform:uppercase;letter-spacing:1.2px;border-bottom:1.5px solid #63B72D;padding-bottom:3px}
    .big{font-size:30px;font-weight:bold;color:#0B2E4F;line-height:1}
    .pass{color:#4C9420;font-weight:bold}.fail{color:#C8372D;font-weight:bold}
    .sum td{padding:8px 10px;border:1px solid #cfdcd5;text-align:center;width:25%}
    .sum .cap{font-size:9px;color:#5d6b7a;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
    ol{margin:6px 0 0 16px;padding:0} ol li{margin:3px 0;line-height:1.45}
    .note{font-size:9px;color:#5d6b7a;margin-top:8px;line-height:1.5}
    .sign{width:100%;border-collapse:collapse;margin-top:34px}
    .sign td{width:50%;font-size:10px;color:#1b2733;vertical-align:bottom}
    .line{border-top:1px solid #1b2733;width:190px;padding-top:4px;display:inline-block}
    .foot{margin-top:12px;border-top:1px solid #dde6e1;padding-top:6px;font-size:8.5px;color:#7a8794;text-align:center;line-height:1.5}
    .wm{position:absolute;top:42%;left:0;right:0;text-align:center;font-size:72px;color:rgba(200,55,45,.12);font-weight:bold;letter-spacing:12px}
    .roll{font-size:16px;letter-spacing:1px}
    .box{border:1px dashed #9fb3c5;padding:8px 10px;margin-top:10px;white-space:pre-wrap}
  </style>`;
}

function pdfHeader_(title, sub, rightHtml) {
  return `<div class="band"></div><div class="band2"></div>
  <table class="hd"><tr>
    <td style="width:120px"><img src="${LOGO_FULL}"></td>
    <td style="text-align:center"><div class="office">Office of the Controller of Examinations</div><h1>${esc_(title)}</h1><div class="sess">${esc_(sub || '')}</div></td>
    <td style="width:150px" class="no">${rightHtml || ''}</td></tr></table>`;
}

function gradeCardPdf_(att, ex, preview) {
  const qs = questions_(ex.ExamID);
  const ans = {};
  answerRows_(att.AttemptID).forEach(a => ans[a.QuestionID] = a);
  const total = Number(att.TotalScore) || 0, max = Number(att.MaxScore) || totalMax_(ex.ExamID);
  const gr = grade_(ex, total, max);
  const sub = [ex.Programme, ex.Semester, ex.Session].filter(String).join(' · ');
  const issued = ist_(toDate_(att.ResultSentAt) || new Date(), 'dd MMM yyyy');
  const qrows = qs.map((q, i) => {
    const a = ans[q.QuestionID] || {};
    const t = String(q.Question).replace(/\s+/g, ' ');
    return `<tr><td>${i + 1}</td><td class="t">${esc_(t.length > 110 ? t.slice(0, 107) + '…' : t)}</td><td>${q.Type === 'MCQ' ? 'Objective' : 'Written'}</td>
      <td>${q.Marks}</td><td><b>${a.AwardedMarks === '' || a.AwardedMarks === undefined ? '—' : a.AwardedMarks}</b></td></tr>`;
  }).join('');
  const html = `<html><head>${pdfCss_()}</head><body><div class="frame">
    ${preview ? '<div class="wm">PREVIEW</div>' : ''}
    ${pdfHeader_('GRADE CARD', sub || 'Online Examination', `Grade Card No.<br><b>${esc_(att.ResultNo || '')}</b><br>Date of issue<br><b>${issued}</b>`)}
    <table class="k">
      <tr><td class="l">Name of candidate</td><td class="v" colspan="3">${esc_(att.Name)}</td></tr>
      <tr><td class="l">Roll number</td><td class="v">${esc_(att.RollNo || '—')}</td><td class="l">Email</td><td class="v">${esc_(att.Email)}</td></tr>
      <tr><td class="l">Programme</td><td class="v">${esc_(ex.Programme || '—')}</td><td class="l">Semester / Term</td><td class="v">${esc_(ex.Semester || '—')}</td></tr>
      <tr><td class="l">Examination</td><td class="v">${esc_(ex.Title)}</td><td class="l">Date of exam</td><td class="v">${ist_(toDate_(att.StartedAt), 'dd MMM yyyy')}</td></tr>
    </table>
    <div class="sec">Statement of grades</div>
    <table class="g"><tr><th>Course code</th><th>Course title</th><th>Credits</th><th>Max. marks</th><th>Marks obtained</th><th>%</th><th>Letter grade</th><th>Grade point</th><th>Credit points</th><th>Result</th></tr>
      <tr><td>${esc_(ex.CourseCode || '—')}</td><td class="t">${esc_(ex.Title)}</td><td>${gr.credits || '—'}</td><td>${max}</td><td><b>${total}</b></td><td>${gr.pct}</td>
        <td><b>${gr.grade}</b></td><td>${gr.gp}</td><td>${gr.cp === '' ? '—' : gr.cp}</td><td class="${gr.result === 'Pass' ? 'pass' : 'fail'}">${gr.result}</td></tr></table>
    <table class="g sum" style="margin-top:10px"><tr>
      <td><div class="big">${gr.grade}</div><div class="cap">Letter grade · ${gr.meaning}</div></td>
      <td><div class="big">${gr.gp}</div><div class="cap">Grade point (out of 10)</div></td>
      <td><div class="big">${gr.pct}%</div><div class="cap">Percentage of marks</div></td>
      <td><div class="big ${gr.result === 'Pass' ? 'pass' : 'fail'}">${gr.result.toUpperCase()}</div><div class="cap">Result (pass grade: P, ${gr.passMark}%)</div></td></tr></table>
    <div class="sec">Marks breakdown</div>
    <table class="g"><tr><th style="width:5%">Q.</th><th>Question</th><th style="width:11%">Type</th><th style="width:9%">Max.</th><th style="width:11%">Awarded</th></tr>${qrows}</table>
    <div class="sec">Grading scale</div>
    <table class="g"><tr><th>Letter grade</th>${bandRows_(ex).map(r => `<td><b>${r.g}</b></td>`).join('')}</tr>
      <tr><th>Meaning</th>${bandRows_(ex).map(r => `<td>${r.m}</td>`).join('')}</tr>
      <tr><th>Grade point</th>${bandRows_(ex).map(r => `<td>${r.gp}</td>`).join('')}</tr>
      <tr><th>Marks (%)</th>${bandRows_(ex).map(r => `<td style="font-size:8.5px">${r.range}</td>`).join('')}</tr></table>
    <div class="note">Letter grades and grade points follow the UGC 10-point grading scale under the Choice Based Credit System. Credit points = grade point × credits.
      A candidate absent from the examination is shown as "Ab" (grade point 0). Percentages are rounded to two decimal places.</div>
    <table class="sign"><tr><td>Verified on ${ist_(toDate_(att.VerifiedAt) || new Date(), 'dd MMM yyyy')}<br>Place: Ahmedabad</td>
      <td style="text-align:right"><span class="line">Controller of Examinations<br>Ahmedabad Centre for Research and Innovation</span></td></tr></table>
    <div class="foot">This is a computer-generated grade card and needs no physical signature. Verification code: <b>${verifyCode_(att.AttemptID)}</b> · Attempt ${esc_(att.AttemptID)}<br>
      Any alteration makes this document invalid. Queries: ${esc_(setting_('FROM_EMAIL') || CFG.FROM_EMAIL)}</div>
  </div></body></html>`;
  return HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf')
    .setName('ACRI_Grade_Card_' + String(att.RollNo || att.Name).replace(/[^A-Za-z0-9]+/g, '_') + '.pdf');
}

function admitCardPdf_(c, ex, preview) {
  const s = toDate_(ex.StartIST), e = toDate_(ex.EndIST);
  const dur = Number(ex.DurationMin) || 0;
  const sub = [ex.Programme || c.Programme, ex.Semester, ex.Session].filter(String).join(' · ');
  const proct = [yes_(ex.Camera) ? 'webcam' : '', yes_(ex.Screen) ? 'entire-screen sharing' : '', yes_(ex.Fullscreen) ? 'fullscreen mode' : ''].filter(String);
  const sameDay = s && e && ist_(s, 'yyyyMMdd') === ist_(e, 'yyyyMMdd');
  const html = `<html><head>${pdfCss_()}</head><body><div class="frame">
    ${preview ? '<div class="wm">PREVIEW</div>' : ''}
    ${pdfHeader_('ADMIT CARD', sub || 'Online Examination', `Admit Card No.<br><b>${esc_(c.AdmitNo || '')}</b><br>Issued<br><b>${ist_(new Date(), 'dd MMM yyyy')}</b>`)}
    <table class="k">
      <tr><td class="l">Roll number</td><td class="v roll">${esc_(c.RollNo)}</td><td class="l">Mode</td><td class="v">Online · remotely proctored</td></tr>
      <tr><td class="l">Name of candidate</td><td class="v" colspan="3">${esc_(c.Name)}</td></tr>
      <tr><td class="l">Registered email</td><td class="v">${esc_(c.Email)}</td><td class="l">Programme</td><td class="v">${esc_(c.Programme || ex.Programme || '—')}</td></tr>
    </table>
    <div class="sec">Examination schedule (Indian Standard Time)</div>
    <table class="g"><tr><th>Course code</th><th>Examination</th><th>Date</th><th>Window opens</th><th>Window closes</th><th>Duration</th></tr>
      <tr><td>${esc_(ex.CourseCode || '—')}</td><td class="t"><b>${esc_(ex.Title)}</b></td><td>${ist_(s, 'dd MMM yyyy')}${sameDay ? '' : ' –<br>' + ist_(e, 'dd MMM yyyy')}</td>
        <td>${ist_(s, 'hh:mm a')}</td><td>${ist_(e, 'hh:mm a')}</td><td>${dur ? dur + ' min' : 'Until close'}</td></tr></table>
    <table class="k">
      <tr><td class="l">Exam portal</td><td class="v">${esc_(setting_('EXAM_SITE_URL'))}</td><td class="l">Access code</td><td class="v roll">${esc_(ex.AccessCode)}</td></tr>
      <tr><td class="l">Proctoring</td><td colspan="3">${proct.length ? 'This exam uses ' + proct.join(', ') + ', plus tab-switch monitoring.' : 'Tab-switch monitoring and copy-paste blocking.'} Total marks: <b>${Number(ex.TotalMarks) || totalMax_(ex.ExamID)}</b>${ex.Credits !== '' && ex.Credits != null ? ' · Credits: <b>' + esc_(ex.Credits) + '</b>' : ''}</td></tr>
    </table>
    <div class="sec">Instructions to the candidate</div>
    <ol>
      <li>Keep this admit card for reference. Your roll number is your identity for this examination.</li>
      <li>Sign in with your registered email <b>${esc_(c.Email)}</b> and the access code above. Other email addresses are not accepted.</li>
      <li>Keep a valid government-issued photo ID ready. You may be asked to show it to the camera.</li>
      <li>Use a laptop or desktop with Google Chrome or Microsoft Edge, a working webcam, stable internet and power backup. Be ready 15 minutes before the window opens.</li>
      <li>Sit alone in a quiet, well-lit room. Mobile phones, smartwatches, earphones, books, notes, other devices and AI tools are not permitted.</li>
      <li>Do not switch tabs or windows, leave fullscreen or stop screen sharing. Every such event is recorded with snapshots and may be treated as use of unfair means.</li>
      <li>Answers save automatically and the exam submits itself when time ends. Only one attempt is allowed.</li>
      <li>Any attempt to impersonate a candidate or use unfair means will lead to cancellation of the examination and further action.</li>
    </ol>
    ${ex.Instructions ? `<div class="box"><b>Examination-specific instructions</b>\n${esc_(ex.Instructions)}</div>` : ''}
    <table class="sign"><tr><td><span class="line">Candidate's signature</span></td>
      <td style="text-align:right"><span class="line">Controller of Examinations<br>Ahmedabad Centre for Research and Innovation</span></td></tr></table>
    <div class="foot">This is a computer-generated admit card and needs no physical signature. Verification code: <b>${verifyCode_(c.CandidateID)}</b><br>
      Queries: ${esc_(setting_('FROM_EMAIL') || CFG.FROM_EMAIL)}</div>
  </div></body></html>`;
  return HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf')
    .setName('ACRI_Admit_Card_' + String(c.RollNo).replace(/[^A-Za-z0-9]+/g, '_') + '.pdf');
}

/* =========================================================================
 *  CoE: CANDIDATES AND ADMIT CARDS
 * ========================================================================= */

function r_listCandidates(req) {
  staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const byEmail = {};
  rows_('Attempts').forEach(a => { if (a.ExamID === ex.ExamID && a.Status !== ST.VOID) byEmail[lower_(a.Email)] = a; });
  const ended = ms_(ex.EndIST) < Date.now();
  const list = rows_('Candidates').filter(c => c.ExamID === ex.ExamID).map(c => {
    const a = byEmail[lower_(c.Email)];
    return {
      id: c.CandidateID, rollNo: String(c.RollNo), name: c.Name, email: c.Email, phone: String(c.Phone || ''), programme: c.Programme,
      admitNo: c.AdmitNo, admitSent: ist_(toDate_(c.AdmitSentAt), 'dd MMM, hh:mm a'),
      attempt: a ? a.Status : (ended ? 'Absent' : ''), attemptId: a ? a.AttemptID : '', grade: a ? a.Grade : (ended ? 'Ab' : '')
    };
  });
  list.sort((x, y) => x.rollNo < y.rollNo ? -1 : x.rollNo > y.rollNo ? 1 : 0);
  return { exam: examOut_(ex), candidates: list };
}

function r_addCandidates(req) {
  const u = staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const input = (req.candidates || []).slice(0, 500);
  if (!input.length) fail_('Add at least one candidate.');
  return withLock_(() => {
    const existing = rows_('Candidates').filter(c => c.ExamID === ex.ExamID);
    const seen = {};
    existing.forEach(c => seen[lower_(c.Email)] = true);
    const prefix = String(ex.RollPrefix || ('ACRI' + Utilities.formatDate(new Date(), CFG.TZ, 'yy') + '-'));
    let seq = 0;
    existing.forEach(c => { const m = String(c.RollNo).match(/(\d+)$/); if (m) seq = Math.max(seq, Number(m[1])); });
    const add = [], skipped = [];
    input.forEach(x => {
      const name = String(x.name || '').trim().replace(/\s+/g, ' '), email = lower_(x.email);
      if (name.length < 2 || !isEmail_(email)) return skipped.push({ email: email || name || '(blank)', reason: 'Missing name or invalid email' });
      if (seen[email]) return skipped.push({ email: email, reason: 'Already registered' });
      seen[email] = true;
      seq++;
      const id = id_('CD');
      add.push({
        CandidateID: id, ExamID: ex.ExamID, RollNo: prefix + String(seq).padStart(4, '0'), Name: name, Email: email,
        Phone: String(x.phone || '').trim().slice(0, 30), Programme: String(x.programme || '').trim().slice(0, 120),
        AdmitNo: docNo_('AC', ex, id), AddedBy: u.email, AddedAt: new Date()
      });
    });
    append_('Candidates', add);
    delBig_('cands_' + ex.ExamID);
    audit_(u.email, 'CANDIDATES_ADDED', ex.ExamID, add.length + ' added, ' + skipped.length + ' skipped');
    return { added: add.length, skipped: skipped };
  });
}

function r_deleteCandidate(req) {
  const u = staff_(req, ['CoE']);
  return withLock_(() => {
    const row = findRow_('Candidates', 'CandidateID', req.candidateId);
    if (!row) fail_('Candidate not found.');
    const c = rowObj_('Candidates', row);
    if (rows_('Attempts').some(a => a.ExamID === c.ExamID && lower_(a.Email) === lower_(c.Email) && a.Status !== ST.VOID))
      fail_('This candidate has already attempted the exam, so they cannot be removed.');
    sh_('Candidates').deleteRow(row);
    delBig_('cands_' + c.ExamID);
    audit_(u.email, 'CANDIDATE_REMOVED', c.ExamID, c.Email);
    return {};
  });
}

function r_setRegisteredOnly(req) {
  const u = staff_(req, ['CoE']);
  const row = findRow_('Exams', 'ExamID', req.examId);
  if (!row) fail_('Exam not found.');
  update_('Exams', row, { RegisteredOnly: yn_(req.value), UpdatedAt: new Date() });
  audit_(u.email, 'REGISTERED_ONLY', req.examId, yn_(req.value));
  return { registeredOnly: !!req.value };
}

function r_admitCardPreview(req) {
  staff_(req, ['CoE']);
  const row = findRow_('Candidates', 'CandidateID', req.candidateId);
  if (!row) fail_('Candidate not found.');
  const c = rowObj_('Candidates', row);
  const pdf = admitCardPdf_(c, exam_(c.ExamID), true);
  return { pdf: Utilities.base64Encode(pdf.getBytes()), name: pdf.getName() };
}

/** Email admit cards. mode: 'selected' (ids), 'unsent' or 'all'. Sends in batches to stay inside the 6-minute limit. */
function r_sendAdmitCards(req) {
  const u = staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const ids = req.ids || [];
  const startedSkip = req.skip || [];
  let list = rows_('Candidates').filter(c => c.ExamID === ex.ExamID);
  if (req.mode === 'selected') list = list.filter(c => ids.indexOf(c.CandidateID) >= 0);
  else if (req.mode === 'unsent') list = list.filter(c => !c.AdmitSentAt);
  list = list.filter(c => startedSkip.indexOf(c.CandidateID) < 0);
  const t0 = Date.now();
  let sent = 0;
  const failed = [], done = [];
  for (let i = 0; i < list.length; i++) {
    if (Date.now() - t0 > 240000) break;
    const c = list[i];
    try {
      const s = toDate_(ex.StartIST), e = toDate_(ex.EndIST);
      sendMail_(c.Email, 'Admit card: ' + ex.Title + ' (Roll No. ' + c.RollNo + ')', mailHtml_('Your admit card', `
        <p>Dear ${esc_(c.Name)},</p>
        <p>You are registered for <b>${esc_(ex.Title)}</b>${ex.CourseCode ? ' (' + esc_(ex.CourseCode) + ')' : ''}. Your admit card is attached.</p>
        <table style="border-collapse:collapse;margin:10px 0">
          <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Roll number</td><td><b>${esc_(c.RollNo)}</b></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Exam window (IST)</td><td><b>${ist_(s)}</b> to <b>${ist_(e)}</b></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Exam portal</td><td><a href="${esc_(setting_('EXAM_SITE_URL'))}">${esc_(setting_('EXAM_SITE_URL'))}</a></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Access code</td><td><b style="letter-spacing:1px">${esc_(ex.AccessCode)}</b></td></tr>
        </table>
        <p>Sign in with this email address (${esc_(c.Email)}). Please read the instructions on the admit card before the exam.</p>`), [admitCardPdf_(c, ex, false)]);
      update_('Candidates', c._row, { AdmitSentAt: new Date() });
      sent++;
      done.push(c.CandidateID);
    } catch (err) {
      failed.push({ id: c.CandidateID, email: c.Email, error: String(err.message || err).slice(0, 160) });
      done.push(c.CandidateID);
    }
  }
  audit_(u.email, 'ADMIT_CARDS_SENT', ex.ExamID, sent + ' sent, ' + failed.length + ' failed');
  return { sent: sent, failed: failed, done: done, remaining: list.length - done.length };
}

/* =========================================================================
 *  EMAIL: ZOHO MAIL API (India) WITH GMAIL BACKUP
 * ========================================================================= */

function sendMail_(to, subject, html, attachments) {
  attachments = attachments || [];
  const props = PropertiesService.getScriptProperties();
  let via = 'Zoho', result = 'OK';
  try {
    if (!props.getProperty('ZOHO_REFRESH_TOKEN')) throw new Error('Zoho not connected');
    zohoSend_(to, subject, html, attachments);
  } catch (zErr) {
    via = 'Gmail (backup)';
    result = 'Zoho failed: ' + String(zErr.message || zErr).slice(0, 200);
    MailApp.sendEmail({
      to: to, subject: subject, htmlBody: html, attachments: attachments,
      name: setting_('FROM_NAME') || CFG.FROM_NAME, replyTo: setting_('FROM_EMAIL') || CFG.FROM_EMAIL
    });
  }
  try { append_('MailLog', { Time: new Date(), To: to, Subject: subject, Via: via, Result: result }); } catch (e) {}
  return via;
}

function zohoToken_() {
  const p = PropertiesService.getScriptProperties();
  const exp = Number(p.getProperty('ZOHO_TOKEN_EXP') || 0);
  if (p.getProperty('ZOHO_ACCESS_TOKEN') && exp > Date.now() + 60000) return p.getProperty('ZOHO_ACCESS_TOKEN');
  const res = UrlFetchApp.fetch(CFG.ZOHO_ACCOUNTS + '/oauth/v2/token', {
    method: 'post', muteHttpExceptions: true,
    payload: {
      refresh_token: p.getProperty('ZOHO_REFRESH_TOKEN'), client_id: p.getProperty('ZOHO_CLIENT_ID'),
      client_secret: p.getProperty('ZOHO_CLIENT_SECRET'), grant_type: 'refresh_token'
    }
  });
  const j = JSON.parse(res.getContentText() || '{}');
  if (!j.access_token) throw new Error('Zoho token refresh failed: ' + res.getContentText().slice(0, 200));
  p.setProperties({ ZOHO_ACCESS_TOKEN: j.access_token, ZOHO_TOKEN_EXP: String(Date.now() + (Number(j.expires_in) || 3600) * 1000) });
  return j.access_token;
}

function zohoFetch_(path, opts) {
  opts = opts || {};
  opts.muteHttpExceptions = true;
  opts.headers = Object.assign({ Authorization: 'Zoho-oauthtoken ' + zohoToken_() }, opts.headers || {});
  const res = UrlFetchApp.fetch(CFG.ZOHO_MAIL + path, opts);
  let j = {};
  try { j = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  if (res.getResponseCode() >= 300 || (j.status && Number(j.status.code) >= 300))
    throw new Error('Zoho ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return j;
}

function zohoSend_(to, subject, html, attachments) {
  const p = PropertiesService.getScriptProperties();
  const acc = p.getProperty('ZOHO_ACCOUNT_ID');
  if (!acc) throw new Error('Zoho account ID missing — run "Connect Zoho Mail" again.');
  const att = (attachments || []).map(b => {
    const j = zohoFetch_(`/api/accounts/${acc}/messages/attachments?fileName=${encodeURIComponent(b.getName() || 'file.pdf')}`, {
      method: 'post', contentType: 'application/octet-stream', payload: b.getBytes()
    });
    const d = Array.isArray(j.data) ? j.data[0] : j.data;
    return { storeName: d.storeName, attachmentPath: d.attachmentPath, attachmentName: d.attachmentName };
  });
  const body = {
    fromAddress: setting_('FROM_EMAIL') || CFG.FROM_EMAIL,
    toAddress: Array.isArray(to) ? to.join(',') : String(to),
    subject: subject, content: html, mailFormat: 'html', askReceipt: 'no'
  };
  if (att.length) body.attachments = att;
  zohoFetch_(`/api/accounts/${acc}/messages`, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) });
}

function mailHtml_(title, body) {
  const logo = setting_('LOGO_URL');
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f8f5;padding:24px 12px">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #dde6e1;border-radius:10px;overflow:hidden">
    <div style="height:6px;background:#166FB1;background:linear-gradient(90deg,#166FB1,#3F9FCF,#63B72D)"></div>
    <div style="padding:22px 26px;color:#1b2733;font-size:14px;line-height:1.55">
      ${logo ? `<img src="${esc_(logo)}" alt="ACRI" style="height:64px;margin-bottom:6px">` : ''}
      <div style="font-size:11px;letter-spacing:2px;color:#166FB1;font-weight:bold;text-transform:uppercase">Ahmedabad Centre for Research &amp; Innovation</div>
      <h2 style="color:#0B2E4F;margin:8px 0 14px;font-size:20px">${esc_(title)}</h2>
      ${body}
      <p style="color:#6b7a88;font-size:12px;margin-top:26px;border-top:1px solid #e6ece8;padding-top:12px">
        Office of the Controller of Examinations · ACRI<br>This is an automated message from the ACRI Online Examination System.</p>
    </div></div></div>`;
}

/* =========================================================================
 *  SHEET MENU (run from the spreadsheet)
 * ========================================================================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ACRI Exams')
    .addItem('1. Set up / repair sheets', 'setupSheets')
    .addItem('2. Connect Zoho Mail', 'connectZoho')
    .addItem('3. Install triggers (auto-submit + activation emails)', 'installTriggers')
    .addSeparator()
    .addItem('Send a test email', 'sendTestEmail')
    .addItem('Zoho connection status', 'zohoStatus')
    .addItem('Reset a staff password', 'resetStaffPassword')
    .addItem('Disconnect Zoho Mail', 'disconnectZoho')
    .addToUi();
}

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CFG.TZ);
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const h = SCHEMA[name];
    const cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    const missing = h.filter(k => cur.indexOf(k) < 0);
    if (!cur.filter(Boolean).length) sh.getRange(1, 1, 1, h.length).setValues([h]);
    else if (missing.length) sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]);
    const lc = sh.getLastColumn();
    sh.getRange(1, 1, 1, lc).setFontWeight('bold').setBackground('#166FB1').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });
  // Text columns that must never be auto-converted.
  [['Exams', 'AccessCode'], ['Staff', 'Phone'], ['Staff', 'PasswordHash'], ['Staff', 'Salt'], ['Attempts', 'Token'], ['Answers', 'Answer'], ['Attempts', 'RollNo'],
   ['Candidates', 'RollNo'], ['Candidates', 'Phone'], ['Submissions', 'Answers1'], ['Submissions', 'Answers2'], ['Submissions', 'Answers3'], ['Submissions', 'Answers4'], ['Exams', 'CourseCode'], ['Exams', 'RollPrefix'], ['Exams', 'GradeBands']]
    .forEach(([s, col]) => { const sh = ss.getSheetByName(s); const j = head_(sh).indexOf(col) + 1; if (j) sh.getRange(2, j, sh.getMaxRows() - 1, 1).setNumberFormat('@'); });
  // Date columns shown in IST.
  [['Exams', ['StartIST', 'EndIST', 'CreatedAt', 'UpdatedAt']], ['Attempts', ['StartedAt', 'Deadline', 'SubmittedAt', 'SentToCoEAt', 'VerifiedAt', 'ResultSentAt']],
   ['Staff', ['RequestedAt', 'ActivatedAt', 'LastLogin']], ['Candidates', ['AdmitSentAt', 'AddedAt']], ['ControlLog', ['Time']], ['Submissions', ['Time', 'Processed']], ['Attempts', ['PausedAt', 'ResumeEta']], ['Events', ['Time']], ['Snapshots', ['Time']], ['MailLog', ['Time']], ['AuditLog', ['Time']]]
    .forEach(([s, cols]) => { const sh = ss.getSheetByName(s); cols.forEach(col => { const j = head_(sh).indexOf(col) + 1; if (j) sh.getRange(2, j, sh.getMaxRows() - 1, 1).setNumberFormat('dd-mmm-yyyy hh:mm:ss'); }); });
  // Dropdowns.
  const dv = (s, col, list) => { const sh = ss.getSheetByName(s); const j = head_(sh).indexOf(col) + 1; if (j) sh.getRange(2, j, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build()); };
  dv('Staff', 'Status', ['Pending', 'Active', 'Disabled', 'Rejected']);
  dv('Staff', 'Role', ['CoE', 'Reviewer', 'Setter', 'Moderator']);
  dv('Exams', 'Mode', ['Pool', 'Direct']);
  dv('Pool', 'Status', ['Draft', 'Submitted', 'Approved', 'Rejected']);
  dv('Pool', 'Difficulty', DIFFS);
  try { const ps = ss.getSheetByName('Pool'); if (ps && !ps.isSheetHidden()) ps.hideSheet(); } catch (e) {}
  dv('Exams', 'Status', ['On', 'Off']);
  dv('Exams', 'Priority', PRIORITIES);
  ['Camera', 'Screen', 'Fullscreen', 'LiveProctor', 'ShuffleQuestions', 'RegisteredOnly'].forEach(c => dv('Exams', c, ['Yes', 'No']));
  // Default settings (existing values are kept).
  const st = ss.getSheetByName('Settings');
  const have = rows_('Settings').map(r => String(r.Key));
  DEFAULT_SETTINGS.forEach(r => { if (have.indexOf(r[0]) < 0) st.appendRow(r); });
  // Move older installs to the lighter defaults (more students per second of capacity).
  rows_('Settings').forEach(r => {
    if (r.Key === 'SNAPSHOT_SECONDS' && String(r.Value) === '60') st.getRange(r._row, 2).setValue('180');
    if (r.Key === 'LIVE_SECONDS' && String(r.Value) === '5') st.getRange(r._row, 2).setValue('8');
    // Move links from the old Google Sites addresses to the single OES site.
    const oldSite = /^https?:\/\/(www\.)?(exam|admin\.exam|coe\.exam|review\.exam|control\.exam|papers\.exam)\.acriindia\.org\/?$/i;
    const def = DEFAULT_SETTINGS.find(d => d[0] === r.Key);
    if (def && /_SITE_URL$/.test(r.Key) && oldSite.test(String(r.Value).trim())) st.getRange(r._row, 2).setValue(def[1]);
  });
  st.setColumnWidth(1, 210); st.setColumnWidth(2, 330); st.setColumnWidth(3, 460);
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  examFolder_(null);
  cache_().remove('settings');
  SpreadsheetApp.getUi().alert('ACRI Exams', 'Sheets are ready.\n\nNext: fill ADMIN_EMAIL in the Settings tab, then use "Connect Zoho Mail" and "Install triggers".', SpreadsheetApp.getUi().ButtonSet.OK);
}

function connectZoho() {
  const ui = SpreadsheetApp.getUi();
  const ask = (t, m) => { const r = ui.prompt(t, m, ui.ButtonSet.OK_CANCEL); if (r.getSelectedButton() !== ui.Button.OK) throw new Error('Cancelled'); return r.getResponseText().trim(); };
  try {
    const id = ask('Connect Zoho Mail (1/3)', 'Client ID from api-console.zoho.in → Self Client:');
    const secret = ask('Connect Zoho Mail (2/3)', 'Client Secret:');
    const code = ask('Connect Zoho Mail (3/3)', 'Generated code (Self Client → Generate Code)\nScope: ' + CFG.ZOHO_SCOPES + '\nThe code expires within minutes, so paste it quickly:');
    const res = UrlFetchApp.fetch(CFG.ZOHO_ACCOUNTS + '/oauth/v2/token', {
      method: 'post', muteHttpExceptions: true,
      payload: { code: code, client_id: id, client_secret: secret, grant_type: 'authorization_code' }
    });
    const j = JSON.parse(res.getContentText() || '{}');
    if (!j.refresh_token) throw new Error('Zoho did not return a refresh token: ' + res.getContentText().slice(0, 300) + '\n\nGenerate a fresh code and try again.');
    const p = PropertiesService.getScriptProperties();
    p.setProperties({
      ZOHO_CLIENT_ID: id, ZOHO_CLIENT_SECRET: secret, ZOHO_REFRESH_TOKEN: j.refresh_token,
      ZOHO_ACCESS_TOKEN: j.access_token, ZOHO_TOKEN_EXP: String(Date.now() + (Number(j.expires_in) || 3600) * 1000)
    });
    const accs = zohoFetch_('/api/accounts', { method: 'get' }).data || [];
    const from = lower_(setting_('FROM_EMAIL') || CFG.FROM_EMAIL);
    const acc = accs.find(a => JSON.stringify(a).toLowerCase().indexOf(from) >= 0) || accs[0];
    if (!acc) throw new Error('No Zoho Mail account was found for this login.');
    p.setProperty('ZOHO_ACCOUNT_ID', String(acc.accountId));
    const matched = JSON.stringify(acc).toLowerCase().indexOf(from) >= 0;
    ui.alert('Zoho Mail connected', 'Account: ' + (acc.primaryEmailAddress || acc.mailboxAddress || acc.accountId) +
      (matched ? '' : '\n\nWarning: ' + from + ' was not found on this account. Emails may fail and fall back to Gmail. Generate the code while signed in as ' + from + '.') +
      '\n\nUse "Send a test email" to confirm.', ui.ButtonSet.OK);
  } catch (e) {
    if (String(e.message) !== 'Cancelled') ui.alert('Zoho connection failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function zohoStatus() {
  const p = PropertiesService.getScriptProperties();
  const ui = SpreadsheetApp.getUi();
  if (!p.getProperty('ZOHO_REFRESH_TOKEN')) return ui.alert('Zoho Mail is not connected. Emails go through Gmail (backup).');
  try { zohoToken_(); ui.alert('Zoho Mail is connected.\nAccount ID: ' + p.getProperty('ZOHO_ACCOUNT_ID') + '\nSender: ' + (setting_('FROM_EMAIL') || CFG.FROM_EMAIL)); }
  catch (e) { ui.alert('Zoho Mail is connected but the token failed:\n' + e.message); }
}

function disconnectZoho() {
  const p = PropertiesService.getScriptProperties();
  ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ACCESS_TOKEN', 'ZOHO_TOKEN_EXP', 'ZOHO_ACCOUNT_ID'].forEach(k => p.deleteProperty(k));
  SpreadsheetApp.getUi().alert('Zoho Mail disconnected. Emails will use Gmail until you connect again.');
}

function sendTestEmail() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Send a test email', 'Send to which address?', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const via = sendMail_(r.getResponseText().trim(), 'ACRI Exams: test email', mailHtml_('Test email', '<p>If you can read this, email from the ACRI Online Examination System is working.</p>'), [resultPdfTest_()]);
  ui.alert('Sent via ' + via + '. Check the MailLog tab for details.');
}

function resultPdfTest_() {
  return HtmlService.createHtmlOutput(`<div style="font-family:Arial;text-align:center;padding:40px"><img src="${LOGO_FULL}" style="height:120px"><h2 style="color:#0B2E4F">Test attachment</h2></div>`)
    .getBlob().getAs('application/pdf').setName('ACRI_test.pdf');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['closeExpiredAttempts', 'onStaffEdit', 'controlLoop', 'processSubmissions'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('closeExpiredAttempts').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('controlLoop').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('processSubmissions').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('onStaffEdit').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  SpreadsheetApp.getUi().alert('Triggers installed:\n• Expired attempts are auto-submitted every 5 minutes\n• Master Control checks the system load every minute (it sleeps when no exam is running)\n• Submitted answers are written to the sheets every minute\n• Staff get an email when you set their Status to Active');
}

/** Installable onEdit: email staff when their Status is changed to Active. */
function onStaffEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== 'Staff' || e.range.getRow() < 2) return;
    const h = head_(sh);
    const sc = h.indexOf('Status') + 1;
    if (e.range.getColumn() > sc || e.range.getLastColumn() < sc) return;
    for (let r = e.range.getRow(); r <= e.range.getLastRow(); r++) {
      const o = rowObj_('Staff', r);
      if (lower_(o.Status) !== 'active' || o.ActivatedAt) continue;
      update_('Staff', r, { ActivatedAt: new Date() });
      const portal = normRole_(o.Role) === 'CoE' ? setting_('COE_SITE_URL') : setting_('REVIEW_SITE_URL');
      sendMail_(o.Email, 'Your ACRI Examinations account is active', mailHtml_('Your account is active', `
        <p>Dear ${esc_(o.Name)},</p><p>Your <b>${esc_(normRole_(o.Role))}</b> account on the ACRI Online Examination System is now active.</p>
        <p>Sign in with ${esc_(o.Email)} and the password you chose: <a href="${esc_(portal)}">${esc_(portal)}</a></p>`));
      audit_('Sheet', 'ACCOUNT_ACTIVATED', o.Email, '');
    }
  } catch (err) { console.error(err); }
}

function resetStaffPassword() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Reset a staff password', 'Staff email address:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const row = staffRow_(r.getResponseText());
  if (!row) return ui.alert('No staff account with that email.');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  const salt = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid())).slice(0, 32);
  update_('Staff', row._row, { PasswordHash: hash_(pw, salt), Salt: salt });
  sendMail_(row.Email, 'Your ACRI Examinations password was reset', mailHtml_('Password reset', `
    <p>Dear ${esc_(row.Name)},</p><p>Your temporary password is: <b style="font-size:16px;letter-spacing:1px">${pw}</b></p>
    <p>Please sign in and keep it safe. Ask the Controller of Examinations if you need it changed again.</p>`));
  audit_('Sheet', 'PASSWORD_RESET', row.Email, '');
  ui.alert('A temporary password was emailed to ' + row.Email + '.');
}

/* =========================================================================
 *  MASTER CONTROL — load monitoring, auto pause/resume, stress test, planning
 *  (oes.acriindia.org.in/control)
 * ========================================================================= */

const PAUSED_W = 1 / 30;          // requests per second from a paused student (slow ticks only)
const DEFAULT_CAPACITY_RPS = 12;  // used until a stress test has been run
const PRIORITIES = ['High', 'Normal', 'Low', 'Never pause'];

/* ---- request metrics (sharded cache buckets of 10 seconds) ---- */

function metric_(action, ms, ok, lat, fails) {
  try {
    const c = cache_();
    const k = 'mx' + Math.floor(Date.now() / 10000) + '_' + Math.floor(Math.random() * 4);
    const o = JSON.parse(c.get(k) || '{"n":0,"ms":0,"e":0,"l":0,"ln":0,"f":0,"s":0}');
    o.n++; o.ms += ms;
    if (!ok) o.e++;
    if (lat > 0 && lat < 120000) { o.l += lat; o.ln++; }
    if (fails > 0 && fails < 100) o.f += fails;
    if (action === 'stressPing') o.s++;
    c.put(k, JSON.stringify(o), 300);
  } catch (e) {}
}

function metrics_(sec) {
  const now = Date.now(), first = Math.floor((now - sec * 1000) / 10000) + 1, last = Math.floor(now / 10000);
  const keys = [];
  for (let b = first; b <= last; b++) for (let i = 0; i < 4; i++) keys.push('mx' + b + '_' + i);
  const got = cache_().getAll(keys);
  const t = { n: 0, ms: 0, e: 0, l: 0, ln: 0, f: 0, s: 0 };
  Object.keys(got).forEach(k => { try { const o = JSON.parse(got[k]); Object.keys(t).forEach(x => t[x] += Number(o[x]) || 0); } catch (e) {} });
  const span = Math.max(10, (last - first + 1) * 10);
  return {
    n: t.n, rps: Math.round(t.n / span * 100) / 100, avgMs: t.n ? Math.round(t.ms / t.n) : 0,
    errRate: t.n ? Math.round((t.e + t.f) / (t.n + t.f) * 1000) / 1000 : 0,
    cliLat: t.ln ? Math.round(t.l / t.ln) : 0, cliN: t.ln, stress: t.s
  };
}

/* ---- capacity model ---- */

function capacity_(s) {
  s = s || settings_();
  const measured = Number(s.CAPACITY_RPS) || 0;
  const raw = measured || DEFAULT_CAPACITY_RPS;
  const safety = Math.min(100, Math.max(30, Number(s.CAPACITY_SAFETY) || 80)) / 100;
  const usable = raw * safety;
  const wp = weight_({ Camera: 'Yes', Screen: 'Yes', LiveProctor: 'No' }, s);
  const wb = weight_({ Camera: 'No', Screen: 'No', LiveProctor: 'No' }, s);
  const watch = watchBudget_(s);
  return {
    raw: raw, usable: Math.round(usable * 100) / 100, safety: Math.round(safety * 100), estimated: !measured,
    testedAt: String(s.CAPACITY_TESTED_AT || ''),
    students: { live: Math.max(0, Math.floor((usable - watch) / wp)), proctored: Math.floor(usable / wp), basic: Math.floor(usable / wb) },
    weights: { live: wp, proctored: wp, basic: wb, watch: watch },
    timing: { heartbeat: hbSec_(s), live: liveSec_(s), snapshot: snapSec_(s), pageSize: pageSize_(s) }
  };
}

/**
 * Average requests per second one writing student creates. Students check in every HEARTBEAT_SECONDS;
 * routine snapshots cost ~4 check-ins each. Live Proctor frames are NOT per student: only the students
 * on a grid page someone is watching send frames (see watchBudget_).
 */
function weight_(ex, s) {
  s = s || settings_();
  const cam = yes_(ex.Camera), scr = yes_(ex.Screen);
  const snap = (cam || scr) ? 4 / snapSec_(s) : 0;
  return Math.round((1 / hbSec_(s) + snap + 0.01) * 10000) / 10000;
}

/** Load of one Live Proctor grid page being watched (fixed, whatever the exam size). */
function watchBudget_(s) { s = s || settings_(); return Math.round(pageSize_(s) / liveSec_(s) * 100) / 100; }
function exLoad_(e, n, s) { return n * weight_(e, s) + ((yes_(e.LiveProctor) && (yes_(e.Camera) || yes_(e.Screen)) && n > 0) ? watchBudget_(s) : 0); }

function ctlCfg_(s) {
  s = s || settings_();
  const n = (k, d, lo, hi) => { const v = Number(s[k]); return isNaN(v) || s[k] === '' ? d : Math.min(hi, Math.max(lo, v)); };
  return {
    mode: lower_(s.CONTROL_MODE || 'Auto') === 'manual' ? 'Manual' : 'Auto',
    pauseAt: n('PAUSE_AT_PCT', 100, 50, 150), target: n('TARGET_PCT', 85, 30, 100), resumeBelow: n('RESUME_BELOW_PCT', 70, 20, 95),
    bufferMin: n('RESUME_BUFFER_MIN', 2, 0, 30), slowMs: n('SLOW_MS', 4000, 1000, 30000), safety: n('CAPACITY_SAFETY', 80, 30, 100),
    hbSec: hbSec_(s), liveSec: liveSec_(s), snapSec: snapSec_(s)
  };
}

function priority_(ex) { const p = String((ex && ex.Priority) || 'Normal'); return PRIORITIES.indexOf(p) >= 0 ? p : 'Normal'; }
function expected_(ex, regCount) { return Number(ex.ExpectedCandidates) || regCount || 0; }
function isPaused_(a) { return !!toDate_(a.PausedAt); }

/* ---- pause / resume / extend (mutate attempt objects; applyAtts_ writes them) ---- */

const ATT_CTL_COLS = ['PausedAt', 'PausedReason', 'ResumeEta', 'Deadline', 'PausedSecTotal', 'ExtendedMin', 'Notice'];

function pauseAtt_(a, reason, etaMs, now) {
  a.PausedAt = new Date(now);
  a.PausedReason = String(reason).slice(0, 300);
  a.ResumeEta = etaMs ? new Date(etaMs) : '';
}

function resumeAtt_(a, now, bufferMin) {
  const pausedMs = Math.max(0, now - ms_(a.PausedAt));
  const add = pausedMs + bufferMin * 60000;
  a.Deadline = new Date(ms_(a.Deadline) + add);
  a.PausedSecTotal = (Number(a.PausedSecTotal) || 0) + Math.round(pausedMs / 1000);
  a.ExtendedMin = Math.round(((Number(a.ExtendedMin) || 0) + add / 60000) * 10) / 10;
  a.PausedAt = ''; a.PausedReason = ''; a.ResumeEta = '';
  const mins = Math.max(1, Math.round(add / 60000));
  a.Notice = JSON.stringify({ id: newToken_().slice(0, 8), text: 'Your exam has resumed. ' + mins + ' minute' + (mins === 1 ? ' was' : 's were') + ' added to your time.' });
  return add;
}

function extendAtt_(a, minutes) {
  a.Deadline = new Date(ms_(a.Deadline) + minutes * 60000);
  a.ExtendedMin = Math.round(((Number(a.ExtendedMin) || 0) + minutes) * 10) / 10;
  a.Notice = JSON.stringify({ id: newToken_().slice(0, 8), text: minutes + ' minute' + (minutes === 1 ? ' was' : 's were') + ' added to your exam time by the Controller of Examinations.' });
}

/** Write changed attempts back (column writes, inside the script lock) and refresh their cache entries. */
function applyAtts_(all, changed) {
  if (!changed.length) return;
  writeCols_('Attempts', all, ATT_CTL_COLS);
  const o = {};
  changed.forEach(a => o['att_' + a.AttemptID] = JSON.stringify(attCacheObj_(a)));
  cache_().putAll(o, 21600);
}

function writeCols_(name, rows, cols) {
  const sh = sh_(name);
  const h = head_(sh);
  rows.forEach((r, i) => { if (r._row !== i + 2) throw new Error('Row order mismatch in ' + name); });
  cols.forEach(col => {
    const j = h.indexOf(col);
    if (j < 0 || !rows.length) return;
    sh.getRange(2, j + 1, rows.length, 1).setValues(rows.map(r => [cell_(r[col])]));
  });
  if (name === 'Exams') examsCacheClear_();
}

function ctlLog_(actor, action, scope, detail) {
  try { append_('ControlLog', { Time: new Date(), Actor: actor, Action: action, Scope: scope || '', Detail: String(detail || '').slice(0, 1000) }); } catch (e) {}
}

/* ---- the controller ---- */

/** Time-driven trigger (every minute). Sleeps cheaply when no exam is running. */
function controlLoop() {
  const c = cache_();
  if (Date.now() < Number(c.get('ctl_sleep_until') || 0)) return;
  try {
    const st = controlRun_('Auto', true);
    if (!st.load.active && !st.load.paused && !st.exams.some(e => e.state === 'live')) {
      const nextStart = rows_('Exams').filter(e => e.Status === 'On' && ms_(e.StartIST) > Date.now()).map(e => ms_(e.StartIST)).sort((a, b) => a - b)[0];
      const until = Math.min(nextStart ? nextStart - 120000 : Infinity, Date.now() + 30 * 60000);
      if (until > Date.now()) c.put('ctl_sleep_until', String(until), 3600);
    }
  } catch (e) { console.error('controlLoop', e); }
}

function controlRun_(actor, force) {
  const c = cache_();
  if (!force) {
    const last = Number(c.get('ctl_last') || 0);
    const cached = c.get('ctl_state');
    if (cached && Date.now() - last < 8000) return JSON.parse(cached);
  }
  return withLock_(() => {
    const now = Date.now();
    c.put('ctl_last', String(now), 600);
    const s = settings_(), cfg = ctlCfg_(s), cap = capacity_(s);
    const exams = rows_('Exams'), byId = {}, W = {};
    exams.forEach(e => { byId[e.ExamID] = e; W[e.ExamID] = weight_(e, s); });
    const all = rows_('Attempts');
    const ip = all.filter(a => a.Status === ST.IP);
    const ca = ip.length ? c.getAll(ip.map(a => 'att_' + a.AttemptID)) : {};
    const live = ip.filter(a => { try { return JSON.parse(ca['att_' + a.AttemptID] || '{}').status !== ST.SUB; } catch (e) { return true; } });
    const wl = c.getAll(exams.filter(e => yes_(e.LiveProctor)).map(e => 'wl_' + e.ExamID));
    let watchTiles = 0;
    Object.keys(wl).forEach(k => { try { const m = JSON.parse(wl[k]); Object.keys(m).forEach(v => { if (now - m[v].t < 30000) watchTiles += Number(m[v].n) || 0; }); } catch (e) {} });
    const watchLoad = watchTiles / liveSec_(s);
    const wOf = a => isPaused_(a) ? PAUSED_W : (W[a.ExamID] || 0.1);
    const loadNow = () => live.reduce((t, a) => t + wOf(a), 0) + watchLoad;
    const m = metrics_(60);
    const stress = !!c.get('stress_active');
    const healthBad = !stress && ((m.cliN >= 5 && m.cliLat > cfg.slowMs) || (m.n >= 20 && m.errRate > 0.05));
    const changed = [], done = { paused: {}, resumed: {} };
    const note = (kind, a) => { done[kind][a.ExamID] = (done[kind][a.ExamID] || 0) + 1; if (changed.indexOf(a) < 0) changed.push(a); };

    // 1. Timed manual pauses whose resume time has come (in either mode).
    live.filter(a => isPaused_(a) && /^Manual/.test(a.PausedReason) && toDate_(a.ResumeEta) && ms_(a.ResumeEta) <= now)
      .forEach(a => { resumeAtt_(a, now, cfg.bufferMin); note('resumed', a); });

    // 2. Automatic load shedding and recovery.
    let util = loadNow() / cap.usable;
    if (cfg.mode === 'Auto' && !stress) {
      if (util * 100 > cfg.pauseAt || healthBad) {
        const goal = (healthBad && util * 100 <= cfg.pauseAt) ? loadNow() * 0.75 : cap.usable * cfg.target / 100;
        const rank = { Low: 0, Normal: 1, High: 2 };
        const cands = live.filter(a => !isPaused_(a) && priority_(byId[a.ExamID]) !== 'Never pause' && ms_(a.Deadline) - now > 5 * 60000)
          .sort((x, y) => (rank[priority_(byId[x.ExamID])] - rank[priority_(byId[y.ExamID])]) || (ms_(y.StartedAt) - ms_(x.StartedAt)));
        for (let i = 0; i < cands.length && loadNow() > goal; i++) { pauseAtt_(cands[i], 'Auto: system at capacity', 0, now); note('paused', cands[i]); }
        c.remove('ctl_low_since');
      } else {
        const queue = live.filter(a => isPaused_(a) && /^Auto/.test(a.PausedReason)).sort((x, y) => ms_(x.PausedAt) - ms_(y.PausedAt));
        if (queue.length && util * 100 < cfg.resumeBelow) {
          const since = Number(c.get('ctl_low_since') || 0);
          if (!since) c.put('ctl_low_since', String(now), 600);
          else if (now - since >= 45000) {
            for (const a of queue) {
              if (loadNow() - PAUSED_W + (W[a.ExamID] || 0.3) > cap.usable * cfg.target / 100) break;
              resumeAtt_(a, now, cfg.bufferMin); note('resumed', a);
            }
            c.remove('ctl_low_since');
          }
        } else c.remove('ctl_low_since');
      }
    }

    // 3. Expected resume times for the waiting queue (when running students finish).
    const running = live.filter(a => !isPaused_(a)).map(a => ({ t: ms_(a.Deadline), w: W[a.ExamID] || 0.3 })).sort((x, y) => x.t - y.t);
    let head = cap.usable * cfg.target / 100 - loadNow(), i = 0, lastT = now;
    live.filter(a => isPaused_(a) && !(/^Manual/.test(a.PausedReason) && toDate_(a.ResumeEta)))
      .sort((x, y) => ms_(x.PausedAt) - ms_(y.PausedAt)).forEach(a => {
        const need = (W[a.ExamID] || 0.3) - PAUSED_W;
        while (head < need && i < running.length) { head += running[i].w; lastT = running[i].t; i++; }
        let eta = 0;
        if (head >= need) { eta = Math.max(now + 120000, lastT + 90000); head -= need; }
        const cur = ms_(a.ResumeEta);
        if (Math.abs(cur - eta) > 60000 || (!eta && cur)) { a.ResumeEta = eta ? new Date(eta) : ''; if (changed.indexOf(a) < 0) changed.push(a); }
      });

    applyAtts_(all, changed);
    Object.keys(done.paused).forEach(id => ctlLog_(actor, 'AUTO_PAUSE', id, done.paused[id] + ' student(s) paused: system at ' + Math.round(util * 100) + '% of capacity' + (healthBad ? ', slow responses' : '')));
    Object.keys(done.resumed).forEach(id => ctlLog_(actor, 'RESUME', id, done.resumed[id] + ' student(s) resumed; paused time added back + ' + cfg.bufferMin + ' min'));
    if (changed.length) c.remove('ctl_sleep_until');

    util = loadNow() / cap.usable;
    const full = cfg.mode === 'Auto' && !stress && (util * 100 > cfg.pauseAt || healthBad || live.some(a => isPaused_(a) && /^Auto/.test(a.PausedReason)));
    c.put('ctl_admit', full ? '0' : '1', 300);

    const st = controlState_(cfg, cap, exams, all, live, W, m, healthBad, stress, util, now);
    st.load.rps = Math.round(loadNow() * 100) / 100;
    st.load.watchTiles = watchTiles;
    // history (one point per ≥10 s)
    let hist = [];
    try { hist = JSON.parse(c.get('ctl_hist') || '[]'); } catch (e) {}
    if (!hist.length || now - hist[hist.length - 1].t >= 10000) {
      hist.push({ t: now, u: Math.round(util * 100), a: st.load.active, p: st.load.paused, l: m.cliLat, ms: m.avgMs });
      hist = hist.filter(h => now - h.t < 3 * 3600000).slice(-360);
      c.put('ctl_hist', JSON.stringify(hist), 21600);
    }
    st.hist = hist;
    c.put('ctl_state', JSON.stringify(st), 60);
    return st;
  });
}

function controlState_(cfg, cap, exams, all, live, W, m, healthBad, stress, util, now) {
  const reg = {};
  rows_('Candidates').forEach(cd => reg[cd.ExamID] = (reg[cd.ExamID] || 0) + 1);
  const seenKeys = live.map(a => 'seen_' + a.AttemptID);
  const seen = seenKeys.length ? cache_().getAll(seenKeys) : {};
  const paused = live.filter(isPaused_);
  const status = (healthBad || util * 100 > cfg.pauseAt) ? 'Overloaded' : util * 100 > cfg.target ? 'Busy' : paused.length ? 'Recovering' : live.length ? 'Normal' : 'Idle';
  const relevant = exams.filter(e => {
    const s0 = ms_(e.StartIST), e0 = ms_(e.EndIST);
    return live.some(a => a.ExamID === e.ExamID) || (e0 > now - 3600000 && s0 < now + 24 * 3600000);
  });
  const examOut = relevant.map(e => {
    const mine = live.filter(a => a.ExamID === e.ExamID);
    const p = mine.filter(isPaused_).length, act = mine.length - p;
    return {
      id: e.ExamID, title: e.Title, code: String(e.AccessCode), state: examState_(e), status: e.Status,
      start: ms_(e.StartIST), end: ms_(e.EndIST), startIST: ist_(toDate_(e.StartIST), 'dd MMM, hh:mm a'), endIST: ist_(toDate_(e.EndIST), 'dd MMM, hh:mm a'),
      expected: Number(e.ExpectedCandidates) || 0, registered: reg[e.ExamID] || 0, active: act, paused: p,
      weight: W[e.ExamID], loadPct: Math.round((act * W[e.ExamID] + p * PAUSED_W) / cap.usable * 100),
      priority: priority_(e), hold: yes_(e.Hold), live: yes_(e.LiveProctor), duration: Number(e.DurationMin) || 0
    };
  }).sort((x, y) => (y.active + y.paused) - (x.active + x.paused) || x.start - y.start);

  // Upcoming 7 days: projected load at each exam's start.
  const horizon = exams.filter(e => ms_(e.EndIST) > now && ms_(e.StartIST) < now + 7 * 24 * 3600000);
  const upcoming = horizon.map(e => {
    const t = Math.max(now, ms_(e.StartIST));
    const at = horizon.filter(o => ms_(o.StartIST) <= t + 60000 && ms_(o.EndIST) > t);
    const proj = at.reduce((sum, o) => sum + exLoad_(o, expected_(o, reg[o.ExamID]), settings_()), 0);
    const pct = Math.round(proj / cap.usable * 100);
    return {
      id: e.ExamID, title: e.Title, startIST: ist_(toDate_(e.StartIST), 'dd MMM, hh:mm a'), endIST: ist_(toDate_(e.EndIST), 'dd MMM, hh:mm a'),
      start: ms_(e.StartIST), expected: expected_(e, reg[e.ExamID]), expectedSet: !!Number(e.ExpectedCandidates), overlapping: at.length - 1,
      pct: pct, verdict: pct <= cfg.target ? 'Fits' : pct <= cfg.pauseAt ? 'Tight' : 'Over capacity', status: e.Status
    };
  }).sort((x, y) => x.start - y.start);

  return {
    now: now, mode: cfg.mode, cfg: cfg, capacity: cap, stress: stress, status: status,
    load: { rps: Math.round(live.reduce((t, a) => t + (isPaused_(a) ? PAUSED_W : (W[a.ExamID] || 0.3)), 0) * 100) / 100, util: Math.round(util * 100), active: live.length - paused.length, paused: paused.length, healthBad: healthBad,
      connected: live.filter(a => now - Number(seen['seen_' + a.AttemptID] || 0) < 45000).length },
    metrics: m, exams: examOut, upcoming: upcoming, log: ctlLogRows_(30)
  };
}

function ctlLogRows_(n) {
  const sh = sh_('ControlLog');
  const lr = sh.getLastRow();
  if (lr < 2) return [];
  const from = Math.max(2, lr - n + 1);
  const h = head_(sh);
  return sh.getRange(from, 1, lr - from + 1, h.length).getValues().reverse().map(r => {
    const o = {}; h.forEach((k, j) => o[k] = r[j]);
    return { time: ist_(toDate_(o.Time), 'dd MMM, hh:mm:ss a'), actor: o.Actor, action: o.Action, scope: o.Scope, detail: o.Detail };
  });
}

/* ---- Master Control API (CoE accounts) ---- */

function r_controlState(req) { staff_(req, ['CoE']); const st = controlRun_('Control page', !!req.force); return { state: st }; }

function r_controlSettings(req) {
  const u = staff_(req, ['CoE']);
  const v = req.values || {};
  const map = { mode: 'CONTROL_MODE', pauseAt: 'PAUSE_AT_PCT', target: 'TARGET_PCT', resumeBelow: 'RESUME_BELOW_PCT', bufferMin: 'RESUME_BUFFER_MIN', slowMs: 'SLOW_MS', safety: 'CAPACITY_SAFETY',
    hbSec: 'HEARTBEAT_SECONDS', liveSec: 'LIVE_SECONDS', snapSec: 'SNAPSHOT_SECONDS' };
  const merged = Object.assign({}, settings_());
  Object.keys(map).forEach(k => { if (v[k] !== undefined) merged[map[k]] = String(v[k]); });
  const chk = ctlCfg_(merged);
  if (chk.target >= chk.pauseAt) fail_('"Target after pausing" must be lower than "Pause at".');
  if (chk.resumeBelow >= chk.target) fail_('"Resume below" must be lower than "Target after pausing".');
  Object.keys(map).forEach(k => {
    if (v[k] === undefined) return;
    if (k === 'mode') return setSetting_(map[k], v[k] === 'Manual' ? 'Manual' : 'Auto');
    const n = Number(v[k]);
    if (isNaN(n)) fail_('Settings must be numbers.');
    setSetting_(map[k], String(n));
  });
  const cfg = ctlCfg_();
  ctlLog_(u.email, 'SETTINGS', '', JSON.stringify(v));
  cache_().remove('ctl_last');
  return { cfg: cfg };
}

function r_controlPriority(req) {
  const u = staff_(req, ['CoE']);
  if (PRIORITIES.indexOf(req.priority) < 0) fail_('Unknown priority.');
  const row = findRow_('Exams', 'ExamID', req.examId);
  if (!row) fail_('Exam not found.');
  update_('Exams', row, { Priority: req.priority });
  ctlLog_(u.email, 'PRIORITY', req.examId, req.priority);
  cache_().remove('ctl_last');
  return {};
}

/** Pause / resume / extend. scope: {examId} or {attemptId} or {all:true}. */
function r_controlAction(req) {
  const u = staff_(req, ['CoE']);
  const op = req.op;
  if (['pause', 'resume', 'extend'].indexOf(op) < 0) fail_('Unknown action.');
  const minutes = Number(req.minutes) || 0;
  if (op === 'extend' && !(minutes > 0 && minutes <= 240)) fail_('Extension must be between 1 and 240 minutes.');
  return withLock_(() => {
    const now = Date.now(), cfg = ctlCfg_();
    const all = rows_('Attempts');
    let pick = all.filter(a => a.Status === ST.IP);
    if (req.attemptId) pick = pick.filter(a => a.AttemptID === req.attemptId);
    else if (req.examId) pick = pick.filter(a => a.ExamID === req.examId);
    else if (!req.all) fail_('Choose an exam or a student.');
    const changed = [];
    pick.forEach(a => {
      if (op === 'pause' && !isPaused_(a)) {
        const msg = String(req.message || '').trim();
        pauseAtt_(a, 'Manual' + (msg ? ': ' + msg : ''), minutes ? now + minutes * 60000 : 0, now); changed.push(a);
      } else if (op === 'resume' && isPaused_(a)) { resumeAtt_(a, now, cfg.bufferMin); changed.push(a); }
      else if (op === 'extend') { extendAtt_(a, minutes); changed.push(a); }
    });
    applyAtts_(all, changed);
    if (req.examId && (op === 'pause' || op === 'resume')) {
      const row = findRow_('Exams', 'ExamID', req.examId);
      if (row) update_('Exams', row, { Hold: op === 'pause' ? 'Yes' : '' });
    }
    if (req.all && op === 'resume') {
      const sh = sh_('Exams'), j = head_(sh).indexOf('Hold') + 1, lr = sh.getLastRow();
      if (j && lr > 1) sh.getRange(2, j, lr - 1, 1).clearContent();
    }
    ctlLog_(u.email, op.toUpperCase(), req.attemptId || req.examId || 'All exams',
      changed.length + ' student(s)' + (op === 'extend' ? ' +' + minutes + ' min' : '') + (op === 'pause' && minutes ? ' for ' + minutes + ' min' : '') + (req.message ? ' — ' + req.message : ''));
    const c = cache_(); c.remove('ctl_last'); c.remove('ctl_sleep_until');
    return { changed: changed.length };
  });
}

function r_controlAttempts(req) {
  staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const atts = rows_('Attempts').filter(a => a.ExamID === ex.ExamID && a.Status === ST.IP);
  const keys = [];
  atts.forEach(a => keys.push('seen_' + a.AttemptID, 'viol_' + a.AttemptID));
  const c = keys.length ? cache_().getAll(keys) : {};
  return {
    attempts: atts.map(a => ({
      id: a.AttemptID, name: a.Name, email: a.Email, rollNo: String(a.RollNo || ''), started: ist_(toDate_(a.StartedAt), 'hh:mm a'),
      deadline: ms_(a.Deadline), pausedAt: ms_(a.PausedAt), eta: ms_(a.ResumeEta), reason: String(a.PausedReason || ''),
      seenAt: Number(c['seen_' + a.AttemptID] || 0), violations: Number(c['viol_' + a.AttemptID] || a.Violations || 0),
      extendedMin: Number(a.ExtendedMin) || 0
    })).sort((x, y) => x.deadline - y.deadline)
  };
}

/* ---- stress test ---- */

function r_stressStart(req) {
  const u = staff_(req, ['CoE']);
  const inProgress = rows_('Attempts').filter(a => a.Status === ST.IP).length;
  if (inProgress && !req.force) return { needsForce: true, inProgress: inProgress };
  const token = newToken_(), c = cache_();
  c.put('stress_' + token, u.email, 1800);
  c.put('stress_active', '1', 1800);
  ctlLog_(u.email, 'STRESS_START', '', 'Max ' + (req.maxRps || '?') + ' req/s' + (inProgress ? ', ' + inProgress + ' student(s) writing' : ''));
  return { token: token };
}

/** One simulated student request: same cache traffic as a live tick, sometimes a sheet read. */
function r_stressPing(req) {
  const c = cache_();
  if (!c.get('stress_' + String(req.st || ''))) fail_('Stress test is not running.');
  const k = Math.floor(Math.random() * 20);
  c.get('att_stress' + k);
  c.put('seen_stress' + k, String(Date.now()), 120);
  if (req.payload) c.put('stp_' + k, String(req.payload).slice(0, 95000), 120);
  if (req.sheet) sh_('Attempts').getRange(1, 1, 1, 5).getValues();
  return {};
}

function r_stressEnd(req) {
  const u = staff_(req, ['CoE']);
  const c = cache_();
  if (req.st) c.remove('stress_' + req.st);
  c.remove('stress_active');
  const r = req.result || {};
  let saved = false;
  if (req.save && Number(r.rps) > 0) {
    setSetting_('CAPACITY_RPS', String(Math.round(Number(r.rps) * 10) / 10));
    setSetting_('CAPACITY_TESTED_AT', ist_(new Date()) + ' IST');
    saved = true;
  }
  ctlLog_(u.email, 'STRESS_RESULT', '', 'Sustained ' + (r.rps || 0) + ' req/s, p95 ' + (r.p95 || 0) + ' ms, stopped: ' + (r.stopReason || '—') + (saved ? ' — saved as capacity' : ''));
  c.remove('ctl_last');
  return { saved: saved, capacity: capacity_() };
}

/* ---- planning: will this exam fit? (used by the CoE exam editor) ---- */

function r_capacityPlan(req) {
  staff_(req, ['CoE']);
  const x = req.exam || {};
  const s = settings_(), cfg = ctlCfg_(s), cap = capacity_(s);
  const start = toDate_(x.start), end = toDate_(x.end);
  const expected = Math.max(0, Math.round(Number(x.expected) || 0));
  const pseudo = { Camera: yn_(x.camera), Screen: yn_(x.screen), LiveProctor: yn_(x.live) };
  const w = weight_(pseudo, s);
  const extra = (yes_(pseudo.LiveProctor) && (yes_(pseudo.Camera) || yes_(pseudo.Screen))) ? watchBudget_(s) : 0;
  const usable = cap.usable * cfg.target / 100;
  const out = { capacity: cap, cfg: cfg, weight: w, expected: expected, aloneMax: Math.max(0, Math.floor((usable - extra) / w)) };
  if (!start || !end || end <= start) return Object.assign(out, { verdict: 'Need dates', message: 'Set the start and end time to check capacity.' });

  const reg = {};
  rows_('Candidates').forEach(cd => reg[cd.ExamID] = (reg[cd.ExamID] || 0) + 1);
  const others = rows_('Exams').filter(e => e.ExamID !== x.id && ms_(e.StartIST) < end.getTime() && ms_(e.EndIST) > start.getTime());
  const points = [start.getTime()].concat(others.map(e => ms_(e.StartIST)).filter(t => t > start.getTime() && t < end.getTime()));
  let peak = 0, peakAt = start.getTime();
  points.forEach(t => {
    const l = others.filter(e => ms_(e.StartIST) <= t && ms_(e.EndIST) > t).reduce((sum, e) => sum + exLoad_(e, expected_(e, reg[e.ExamID]), s), 0);
    if (l > peak) { peak = l; peakAt = t; }
  });
  const free = Math.max(0, usable - peak - extra);
  const perBatch = Math.floor(free / w);
  Object.assign(out, {
    others: others.map(e => ({ title: e.Title, window: ist_(toDate_(e.StartIST), 'dd MMM, hh:mm a') + ' – ' + ist_(toDate_(e.EndIST), 'hh:mm a'), expected: expected_(e, reg[e.ExamID]) })),
    otherLoadPct: Math.round(peak / cap.usable * 100), peakAtIST: ist_(new Date(peakAt), 'hh:mm a'), perBatch: perBatch,
    registered: reg[x.id] || 0
  });
  if (!expected) return Object.assign(out, { verdict: 'Need number', message: 'Enter the expected number of candidates to check capacity.' });
  const pct = Math.round((peak + extra + expected * w) / cap.usable * 100);
  out.pct = pct;
  if (perBatch < 1) return Object.assign(out, { verdict: 'No capacity', message: 'Other exams already use the system’s capacity in this window. Choose a different time.' });
  if (expected <= perBatch) {
    out.verdict = expected <= perBatch * 0.8 ? 'Fits' : 'Tight';
    out.message = out.verdict === 'Fits' ? 'All ' + expected + ' candidates can sit at one go.' : 'All ' + expected + ' candidates fit at one go, but close to the limit. Expect automatic pauses if more students join than expected.';
    return out;
  }
  const n = Math.ceil(expected / perBatch), size = Math.ceil(expected / n);
  const dur = Number(x.duration) || 0;
  out.verdict = 'Use batches';
  out.batches = n; out.batchSize = size;
  out.message = expected + ' candidates is more than the ' + perBatch + ' the system can take at once in this window. Run the exam in ' + n + ' batches of about ' + size + '.';
  const noLive = Math.floor(Math.max(0, usable - peak) / w);
  if (yes_(pseudo.LiveProctor) && noLive >= expected) out.alt = 'Or switch off Live Proctor: then all ' + expected + ' fit at one go (snapshots are still stored).';
  else if (yes_(pseudo.LiveProctor) && noLive > perBatch) out.alt = 'Switching off Live Proctor raises the limit to ' + noLive + ' per batch.';
  if (!dur) { out.planNote = 'Set “Time per student” to get a batch timetable.'; return out; }
  const step = (dur + 15) * 60000, windowMs = (dur + 10) * 60000;
  out.plan = [];
  for (let k = 0; k < n; k++) {
    const bs = new Date(start.getTime() + k * step), be = new Date(bs.getTime() + windowMs);
    out.plan.push({ n: k + 1, size: k < n - 1 ? size : expected - size * (n - 1), startInput: Utilities.formatDate(bs, CFG.TZ, "yyyy-MM-dd'T'HH:mm"), endInput: Utilities.formatDate(be, CFG.TZ, "yyyy-MM-dd'T'HH:mm"),
      startIST: ist_(bs, 'dd MMM, hh:mm a'), endIST: ist_(be, 'hh:mm a') });
  }
  const lastEnd = ms_(out.plan[n - 1].endInput);
  if (lastEnd > end.getTime()) out.planNote = 'The last batch ends at ' + ist_(new Date(lastEnd), 'hh:mm a') + ', after your window closes. Widen the window or run some batches on another day.';
  out.planRule = 'Each batch window = time per student + 10 min late entry; 5 min gap between batches.';
  return out;
}

/** Split a saved exam into batches: this exam becomes batch 1; copies get new codes and windows. */
function r_createBatches(req) {
  const u = staff_(req, ['CoE']);
  const plan = (req.plan || []).slice(0, 20);
  if (plan.length < 2) fail_('A batch plan needs at least two batches.');
  return withLock_(() => {
    const ex = exam_(req.examId);
    if (!ex) fail_('Save the exam first.');
    if (rows_('Attempts').some(a => a.ExamID === ex.ExamID && a.Status !== ST.VOID)) fail_('This exam already has attempts, so it cannot be split.');
    const n = plan.length, baseTitle = String(ex.Title).replace(/\s+—\s+Batch \d+ of \d+$/, '');
    const codes = rows_('Exams').map(e => lower_(e.AccessCode));
    const pool = isPool_(ex);
    if (pool && groupId_(ex) !== ex.ExamID) fail_('Split the exam from its first batch.');
    if (pool && toDate_(ex.DrawnAt)) fail_('A paper has already been drawn for this exam, so it cannot be split.');
    const qs = pool ? [] : questions_(ex.ExamID);
    const ids = [ex.ExamID];
    plan.forEach((p, k) => {
      const s0 = toDate_(p.startInput), e0 = toDate_(p.endInput);
      if (!s0 || !e0 || e0 <= s0) fail_('Batch ' + (k + 1) + ' has an invalid time window.');
    });
    // batch 1 = this exam
    update_('Exams', ex._row, { Title: baseTitle + ' — Batch 1 of ' + n, StartIST: toDate_(plan[0].startInput), EndIST: toDate_(plan[0].endInput), ExpectedCandidates: plan[0].size || '', GroupID: ex.ExamID, UpdatedAt: new Date() });
    for (let k = 1; k < n; k++) {
      let code = String(ex.AccessCode).slice(0, 19) + '-B' + (k + 1);
      while (codes.indexOf(lower_(code)) >= 0) code = String(ex.AccessCode).slice(0, 15) + '-B' + (k + 1) + Math.floor(Math.random() * 90 + 10);
      codes.push(lower_(code));
      const id = id_('EX');
      ids.push(id);
      const copy = {};
      SCHEMA.Exams.forEach(col => copy[col] = ex[col]);
      Object.assign(copy, { ExamID: id, Title: baseTitle + ' — Batch ' + (k + 1) + ' of ' + n, AccessCode: code, StartIST: toDate_(plan[k].startInput), EndIST: toDate_(plan[k].endInput),
        ExpectedCandidates: plan[k].size || '', Hold: '', GroupID: ex.ExamID, Blueprint: '', Moderators: '', DrawnAt: '', Status: pool ? 'Off' : ex.Status,
        CreatedBy: u.email, CreatedAt: new Date(), UpdatedAt: new Date() });
      append_('Exams', copy);
      if (!pool) append_('Questions', qs.map(q => ({ QuestionID: id_('Q'), ExamID: id, Order: q.Order, Type: q.Type, Question: q.Question, Options: q.Options, Correct: q.Correct, Marks: q.Marks })));
    }
    // registered candidates: split by roll number across the batches
    const all = rows_('Candidates');
    const mine = all.filter(cd => cd.ExamID === ex.ExamID).sort((a, b) => String(a.RollNo) < String(b.RollNo) ? -1 : 1);
    let moved = 0;
    if (mine.length) {
      const per = Math.ceil(mine.length / n);
      mine.forEach((cd, i) => { const b = Math.min(n - 1, Math.floor(i / per)); if (b > 0) { cd.ExamID = ids[b]; cd.AdmitSentAt = ''; moved++; } });
      if (moved) writeCols_('Candidates', all, ['ExamID', 'AdmitSentAt']);
      ids.forEach(x => delBig_('cands_' + x));
    }
    delBig_('qs_' + ex.ExamID);
    audit_(u.email, 'EXAM_BATCHED', ex.ExamID, n + ' batches: ' + ids.join(', '));
    ctlLog_(u.email, 'BATCHES', ex.ExamID, n + ' batches created' + (moved ? ', ' + moved + ' candidates moved' : ''));
    return { examIds: ids, moved: moved, pool: pool, setsNeeded: pool ? Math.max(3, n + 1) : 0 };
  });
}

/* =========================================================================
 *  SEALED PAPERS — blueprint, paper setters, question pool, random draw
 *  (setters and moderators work on oes.acriindia.org.in/papers)
 *
 *  The CoE defines a blueprint (sections, marks, difficulty mix). Setters write
 *  questions into a pool. When a session (batch) opens, the server draws that
 *  session's paper at random from the unused pool. Nobody chooses the paper and,
 *  through the portals, nobody sees it before it is drawn.
 * ========================================================================= */

const DIFFS = ['Easy', 'Medium', 'Hard'];

function isPool_(ex) { return String((ex && ex.Mode) || '') === 'Pool'; }
function groupId_(ex) { return String(ex.GroupID || ex.ExamID); }
function groupExams_(gid, exams) { return (exams || rows_('Exams')).filter(e => groupId_(e) === gid); }
function groupParent_(gid, exams) { return (exams || rows_('Exams')).find(e => e.ExamID === gid) || null; }

function parseBlueprint_(v) {
  let b = null;
  try { b = typeof v === 'string' ? JSON.parse(v || 'null') : v; } catch (e) { b = null; }
  return b && Array.isArray(b.sections) ? b : { sections: [] };
}

/** Validate and normalise a blueprint sent by the CoE editor. */
function cleanBlueprint_(b) {
  b = parseBlueprint_(b);
  if (!b.sections.length) fail_('Add at least one section to the blueprint.');
  if (b.sections.length > 10) fail_('A blueprint can have at most 10 sections.');
  const out = { sections: [] };
  b.sections.forEach((s, i) => {
    const key = String.fromCharCode(65 + i);
    const name = String(s.name || ('Section ' + key)).trim().slice(0, 60);
    const type = s.type === 'Written' ? 'Written' : 'MCQ';
    const count = Math.round(Number(s.count) || 0), marks = Number(s.marks) || 0;
    if (count < 1 || count > 100) fail_(name + ': number of questions must be between 1 and 100.');
    if (!(marks > 0 && marks <= 100)) fail_(name + ': marks per question must be more than 0.');
    const mix = {};
    let sum = 0;
    DIFFS.forEach(d => { mix[d] = Math.max(0, Math.round(Number((s.mix || {})[d]) || 0)); sum += mix[d]; });
    if (sum !== count) fail_(name + ': the easy + medium + hard counts (' + sum + ') must add up to the number of questions (' + count + ').');
    out.sections.push({ key: key, name: name, type: type, count: count, marks: marks, mix: mix });
  });
  return out;
}
function blueprintTotal_(bp) { return bp.sections.reduce((t, s) => t + s.count * s.marks, 0); }

/** Sets the pool must hold: one per batch plus a reserve, never fewer than 3. */
function setsNeeded_(gid, exams) { return Math.max(3, groupExams_(gid, exams).length + 1); }

function poolRows_(gid) { return rows_('Pool').filter(q => String(q.GroupID) === gid); }
function usableStatus_(parent) { return String(parent.Moderators || '').trim() ? ['Approved'] : ['Submitted', 'Approved']; }

/** Have/need per section × difficulty for the sets not yet drawn. */
function coverage_(gid, exams, pool) {
  exams = exams || rows_('Exams');
  const parent = groupParent_(gid, exams);
  if (!parent) return null;
  const bp = parseBlueprint_(parent.Blueprint);
  const members = groupExams_(gid, exams);
  const drawn = members.filter(e => toDate_(e.DrawnAt)).length;
  const sets = setsNeeded_(gid, exams), remaining = Math.max(0, sets - drawn);
  const ok = usableStatus_(parent);
  pool = pool || poolRows_(gid);
  const free = pool.filter(q => !q.UsedBy && ok.indexOf(String(q.Status)) >= 0);
  const cells = [];
  let ready = bp.sections.length > 0, short = [];
  bp.sections.forEach(s => DIFFS.forEach(d => {
    if (!s.mix[d]) return;
    const need = s.mix[d] * remaining;
    const have = free.filter(q => q.Section === s.key && q.Difficulty === d).length;
    const waiting = pool.filter(q => !q.UsedBy && q.Section === s.key && q.Difficulty === d && ['Draft', 'Submitted'].indexOf(String(q.Status)) >= 0 && ok.indexOf(String(q.Status)) < 0).length;
    cells.push({ section: s.key, name: s.name, difficulty: d, need: need, have: have, waiting: waiting });
    if (have < need) { ready = false; short.push(s.name + ' ' + d.toLowerCase() + ': ' + have + ' of ' + need); }
  }));
  return { sets: sets, drawn: drawn, remaining: remaining, ready: ready, short: short, cells: cells, moderated: ok.length === 1 };
}

function requirePoolReady_(ex, exams) {
  if (!isPool_(ex)) return;
  const cov = coverage_(groupId_(ex), exams);
  if (!cov || !cov.ready) fail_('The question pool is not complete yet, so this exam cannot be switched On. Still needed — ' + (cov ? cov.short.join('; ') : 'a blueprint') + '.');
}

/** Draw this session's paper at random from the unused pool. Call inside the lock. */
function drawPaper_(ex) {
  const exams = rows_('Exams');
  const gid = groupId_(ex), parent = groupParent_(gid, exams);
  if (!parent) fail_('This exam’s paper is not set up. Please contact the invigilator.');
  const bp = parseBlueprint_(parent.Blueprint);
  const ok = usableStatus_(parent);
  const all = rows_('Pool');
  const free = all.filter(q => String(q.GroupID) === gid && !q.UsedBy && ok.indexOf(String(q.Status)) >= 0);
  const picked = [];
  bp.sections.forEach(s => DIFFS.forEach(d => {
    const n = s.mix[d] || 0;
    if (!n) return;
    const cand = free.filter(q => q.Section === s.key && q.Difficulty === d);
    if (cand.length < n) fail_('The paper for this exam is not ready. Please tell your invigilator (code PAPER-' + s.key + '-' + d.charAt(0) + ').');
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
    cand.slice(0, n).forEach(q => picked.push({ q: q, s: s }));
  }));
  // Questions appear section by section; within a section the order is random.
  picked.sort((a, b) => a.s.key < b.s.key ? -1 : a.s.key > b.s.key ? 1 : Math.random() - 0.5);
  const now = new Date();
  append_('Questions', picked.map((p, i) => ({
    QuestionID: id_('Q'), ExamID: ex.ExamID, Order: i + 1, Type: p.s.type, Question: p.q.Question,
    Options: p.s.type === 'MCQ' ? p.q.Options : '', Correct: p.s.type === 'MCQ' ? p.q.Correct : '', Marks: p.s.marks,
    Section: p.s.name, Difficulty: p.q.Difficulty, PoolQID: p.q.PoolQID, ModelAnswer: p.q.ModelAnswer
  })));
  picked.forEach(p => { p.q.UsedBy = ex.ExamID; p.q.UsedAt = now; });
  writeCols_('Pool', all, ['UsedBy', 'UsedAt']);
  update_('Exams', ex._row || findRow_('Exams', 'ExamID', ex.ExamID), { DrawnAt: now, TotalMarks: blueprintTotal_(bp) });
  delBig_('qs_' + ex.ExamID);
  const fp = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, picked.map(p => p.q.PoolQID).sort().join(','))).slice(0, 12);
  audit_('System', 'PAPER_DRAWN', ex.ExamID, picked.length + ' questions drawn at random; fingerprint ' + fp);
  return picked.length;
}

/** Reviewers may open answers of a pool exam only after its session has closed. */
function markGate_(u, ex) {
  if (u.role === 'CoE' || !isPool_(ex)) return;
  if (Date.now() < ms_(ex.EndIST)) fail_('Marking for this session opens when it closes at ' + ist_(toDate_(ex.EndIST)) + ' IST, so the paper stays sealed until then.');
}

/* ---- CoE: setters, moderators, progress (never question content) ---- */

function r_poolStatus(req) {
  staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const exams = rows_('Exams'), gid = groupId_(ex), pool = poolRows_(gid);
  const asg = rows_('Assignments').filter(a => String(a.GroupID) === gid);
  const parent = groupParent_(gid, exams);
  const bp = parseBlueprint_(parent && parent.Blueprint);
  const staff = {};
  rows_('Staff').forEach(s => staff[lower_(s.Email)] = s.Name);
  return {
    groupId: gid, isParent: ex.ExamID === gid, parentTitle: parent ? parent.Title : '',
    coverage: coverage_(gid, exams, pool),
    batches: groupExams_(gid, exams).map(e => ({ id: e.ExamID, title: e.Title, window: ist_(toDate_(e.StartIST), 'dd MMM, hh:mm a') + ' – ' + ist_(toDate_(e.EndIST), 'hh:mm a'),
      drawn: !!toDate_(e.DrawnAt), drawnAt: ist_(toDate_(e.DrawnAt), 'dd MMM, hh:mm a'), status: e.Status })).sort((a, b) => a.title < b.title ? -1 : 1),
    assignments: asg.map(a => {
      const mine = pool.filter(q => lower_(q.SetterEmail) === lower_(a.SetterEmail) && q.Section === a.Section);
      const sec = bp.sections.find(s => s.key === a.Section);
      return { id: a.AssignID, setter: lower_(a.SetterEmail), setterName: staff[lower_(a.SetterEmail)] || '', section: a.Section, sectionName: sec ? sec.name : a.Section,
        count: Number(a.Count) || 0, due: ist_(toDate_(a.Due), 'dd MMM yyyy'), dueInput: toDate_(a.Due) ? Utilities.formatDate(toDate_(a.Due), CFG.TZ, 'yyyy-MM-dd') : '',
        drafts: mine.filter(q => q.Status === 'Draft').length, submitted: mine.filter(q => q.Status === 'Submitted').length,
        approved: mine.filter(q => q.Status === 'Approved').length, rejected: mine.filter(q => q.Status === 'Rejected').length };
    }),
    setters: rows_('Staff').filter(s => lower_(s.Status) === 'active' && normRole_(s.Role) === 'Setter').map(s => ({ email: lower_(s.Email), name: s.Name })),
    moderatorsAvailable: rows_('Staff').filter(s => lower_(s.Status) === 'active' && normRole_(s.Role) === 'Moderator').map(s => ({ email: lower_(s.Email), name: s.Name }))
  };
}

function r_assignSetter(req) {
  const u = staff_(req, ['CoE']);
  const ex = exam_(req.examId);
  if (!ex || !isPool_(ex)) fail_('Save the exam with “Question pool” as the paper source first.');
  const gid = groupId_(ex), parent = groupParent_(gid);
  const bp = parseBlueprint_(parent.Blueprint);
  const sec = bp.sections.find(s => s.key === req.section);
  if (!sec) fail_('Choose a section.');
  const email = lower_(req.setter), st = staffRow_(email);
  if (!st || lower_(st.Status) !== 'active' || normRole_(st.Role) !== 'Setter') fail_('Choose an active paper-setter account.');
  const count = Math.round(Number(req.count) || 0);
  if (count < 1 || count > 500) fail_('Number of questions must be between 1 and 500.');
  const due = toDate_(req.due ? req.due + 'T23:59' : '');
  const a = { AssignID: id_('AS'), GroupID: gid, SetterEmail: email, Section: sec.key, Count: count, Due: due || '', Note: String(req.note || '').slice(0, 500), CreatedBy: u.email, CreatedAt: new Date() };
  append_('Assignments', a);
  audit_(u.email, 'SETTER_ASSIGNED', gid, email + ' · ' + sec.name + ' · ' + count);
  try {
    const target = DIFFS.map(d => Math.round(count * sec.mix[d] / sec.count) + ' ' + d.toLowerCase()).join(', ');
    sendMail_(email, 'Paper setting request: ' + (parent.CourseCode ? parent.CourseCode + ' · ' : '') + baseTitle_(parent.Title), mailHtml_('You have been asked to set questions', `
      <p>Dear ${esc_(st.Name)},</p>
      <p>The Office of the Controller of Examinations requests you to set questions for <b>${esc_(baseTitle_(parent.Title))}</b>${parent.CourseCode ? ' (' + esc_(parent.CourseCode) + ')' : ''}.</p>
      <table style="border-collapse:collapse;margin:10px 0">
        <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Section</td><td><b>${esc_(sec.name)}</b> · ${sec.type === 'MCQ' ? 'multiple choice' : 'written answer'} · ${sec.marks} marks each</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Questions</td><td><b>${count}</b> (aim for about ${esc_(target)})</td></tr>
        ${due ? `<tr><td style="padding:4px 14px 4px 0;color:#5d6b7a">Due by</td><td><b>${ist_(due, 'dd MMM yyyy')}</b></td></tr>` : ''}
      </table>
      ${a.Note ? `<p>${esc_(a.Note)}</p>` : ''}
      <p>Sign in at <a href="${esc_(setting_('PAPERS_SITE_URL'))}">${esc_(setting_('PAPERS_SITE_URL'))}</a>. Your questions are confidential: please do not keep copies outside the system.</p>`));
  } catch (e) { console.error(e); }
  return { assignId: a.AssignID };
}

function r_removeAssignment(req) {
  const u = staff_(req, ['CoE']);
  const row = findRow_('Assignments', 'AssignID', req.assignId);
  if (!row) fail_('Assignment not found.');
  sh_('Assignments').deleteRow(row);
  audit_(u.email, 'SETTER_REMOVED', req.assignId, 'Questions already written stay in the pool');
  return {};
}

/** Emergency only: lets the CoE read the sealed pool. Always logged and reported. */
function r_poolUnseal(req) {
  const u = staff_(req, ['CoE']);
  const reason = String(req.reason || '').trim();
  if (reason.length < 10) fail_('Write the reason for opening the sealed pool (at least 10 characters). It is recorded and reported.');
  const ex = exam_(req.examId);
  if (!ex) fail_('Exam not found.');
  const gid = groupId_(ex);
  audit_(u.email, 'POOL_UNSEALED', gid, reason);
  ctlLog_(u.email, 'POOL_UNSEALED', gid, reason);
  const admin = setting_('ADMIN_EMAIL');
  if (admin) { try { sendMail_(admin, 'ALERT: sealed question pool opened — ' + ex.Title, mailHtml_('A sealed question pool was opened', `<p><b>${esc_(u.name)}</b> (${esc_(u.email)}) opened the sealed question pool of <b>${esc_(ex.Title)}</b> on ${ist_(new Date())} IST.</p><p>Reason given: ${esc_(reason)}</p><p>If this was not expected, consider the unused questions compromised and ask setters for new ones.</p>`)); } catch (e) {} }
  return { questions: poolRows_(gid).map(q => ({ id: q.PoolQID, section: q.Section, difficulty: q.Difficulty, type: q.Type, text: q.Question, options: parseOpts_(q.Options), correct: Number(q.Correct) - 1, status: q.Status, used: q.UsedBy ? 'Used' : 'Unused', setter: q.SetterEmail })) };
}

/* ---- Paper setters ---- */

function baseTitle_(t) { return String(t || '').replace(/\s+—\s+Batch \d+ of \d+$/, ''); }

function r_setterTasks(req) {
  const u = staff_(req, ['Setter']);
  const exams = rows_('Exams');
  const pool = rows_('Pool').filter(q => lower_(q.SetterEmail) === u.email);
  return {
    user: u,
    tasks: rows_('Assignments').filter(a => lower_(a.SetterEmail) === u.email).map(a => {
      const parent = groupParent_(String(a.GroupID), exams);
      if (!parent) return null;
      const bp = parseBlueprint_(parent.Blueprint), sec = bp.sections.find(s => s.key === a.Section);
      if (!sec) return null;
      const mine = pool.filter(q => String(q.GroupID) === String(a.GroupID) && q.Section === a.Section);
      const count = Number(a.Count) || 0;
      return {
        id: a.AssignID, exam: baseTitle_(parent.Title), courseCode: String(parent.CourseCode || ''), programme: String(parent.Programme || ''),
        section: { key: sec.key, name: sec.name, type: sec.type, marks: sec.marks }, count: count, note: a.Note,
        due: ist_(toDate_(a.Due), 'dd MMM yyyy'), overdue: toDate_(a.Due) ? Date.now() > ms_(a.Due) : false,
        target: DIFFS.reduce((o, d) => { o[d] = Math.round(count * sec.mix[d] / sec.count); return o; }, {}),
        questions: mine.map(q => ({ id: q.PoolQID, text: String(q.Question), options: parseOpts_(q.Options), correct: q.Correct === '' ? null : Number(q.Correct) - 1,
          difficulty: q.Difficulty, topic: q.Topic, modelAnswer: q.ModelAnswer, status: q.UsedBy ? 'Used' : q.Status, note: q.ModNote, locked: !!q.UsedBy }))
      };
    }).filter(Boolean)
  };
}

function r_setterSave(req) {
  const u = staff_(req, ['Setter']);
  const q = req.question || {};
  return withLock_(() => {
    const a = rows_('Assignments').find(x => x.AssignID === req.assignId && lower_(x.SetterEmail) === u.email);
    if (!a) fail_('Assignment not found.');
    const parent = groupParent_(String(a.GroupID));
    const sec = parseBlueprint_(parent && parent.Blueprint).sections.find(s => s.key === a.Section);
    if (!sec) fail_('This section no longer exists in the blueprint.');
    const text = String(q.text || '').trim();
    if (text.length < 5) fail_('Write the question.');
    if (DIFFS.indexOf(q.difficulty) < 0) fail_('Choose the difficulty: Easy, Medium or Hard.');
    let options = '', correct = '';
    if (sec.type === 'MCQ') {
      const opts = (q.options || []).map(o => String(o).trim());
      if (opts.length < 2 || opts.some(o => !o)) fail_('Fill in at least two options (no empty options).');
      if (uniq_(opts.map(lower_)).length !== opts.length) fail_('Two options are the same.');
      const ci = Number(q.correct);
      if (!(ci >= 0 && ci < opts.length)) fail_('Mark the correct option.');
      options = JSON.stringify(opts); correct = ci + 1;
    }
    const status = req.submit ? 'Submitted' : 'Draft';
    const obj = { Question: text.slice(0, 20000), Options: options, Correct: correct, Difficulty: q.difficulty, Topic: String(q.topic || '').slice(0, 120),
      ModelAnswer: String(q.modelAnswer || '').slice(0, 20000), Status: status, ModNote: '', UpdatedAt: new Date() };
    if (q.id) {
      const row = findRow_('Pool', 'PoolQID', q.id);
      if (!row) fail_('Question not found.');
      const cur = rowObj_('Pool', row);
      if (lower_(cur.SetterEmail) !== u.email) fail_('You can only edit your own questions.');
      if (cur.UsedBy) fail_('This question has already been used in an exam and is locked.');
      update_('Pool', row, obj);
      return { id: q.id, status: status };
    }
    const mine = rows_('Pool').filter(x => lower_(x.SetterEmail) === u.email && String(x.GroupID) === String(a.GroupID) && x.Section === a.Section).length;
    if (mine >= (Number(a.Count) || 0) + 5) fail_('You have already written more questions than assigned. Edit or delete existing ones instead.');
    const dup = rows_('Pool').find(x => String(x.GroupID) === String(a.GroupID) && lower_(String(x.Question).replace(/\s+/g, ' ')) === lower_(text.replace(/\s+/g, ' ')));
    if (dup) fail_('The same question is already in this pool.');
    const id = id_('PQ');
    append_('Pool', Object.assign(obj, { PoolQID: id, GroupID: a.GroupID, Section: sec.key, Type: sec.type, SetterEmail: u.email, AssignID: a.AssignID, CreatedAt: new Date() }));
    return { id: id, status: status };
  });
}

function r_setterDelete(req) {
  const u = staff_(req, ['Setter']);
  return withLock_(() => {
    const row = findRow_('Pool', 'PoolQID', req.id);
    if (!row) fail_('Question not found.');
    const q = rowObj_('Pool', row);
    if (lower_(q.SetterEmail) !== u.email) fail_('You can only delete your own questions.');
    if (q.UsedBy) fail_('This question has been used in an exam and cannot be deleted.');
    sh_('Pool').deleteRow(row);
    return {};
  });
}

function r_setterSubmit(req) {
  const u = staff_(req, ['Setter']);
  return withLock_(() => {
    const all = rows_('Pool');
    let n = 0;
    all.forEach(q => { if (lower_(q.SetterEmail) === u.email && q.AssignID === req.assignId && q.Status === 'Draft') { q.Status = 'Submitted'; n++; } });
    if (n) writeCols_('Pool', all, ['Status']);
    return { submitted: n };
  });
}

/* ---- Moderators ---- */

function r_modQueue(req) {
  const u = staff_(req, ['Moderator']);
  const exams = rows_('Exams');
  const groups = exams.filter(e => groupId_(e) === e.ExamID && isPool_(e) && reviewersOf_({ Reviewers: e.Moderators }).indexOf(u.email) >= 0);
  const pool = rows_('Pool');
  return {
    user: u,
    groups: groups.map(g => {
      const bp = parseBlueprint_(g.Blueprint);
      const qs = pool.filter(q => String(q.GroupID) === g.ExamID && !q.UsedBy && q.Status !== 'Draft');
      const setters = uniq_(qs.map(q => lower_(q.SetterEmail)));
      return {
        id: g.ExamID, exam: baseTitle_(g.Title), courseCode: String(g.CourseCode || ''),
        sections: bp.sections.map(s => ({ key: s.key, name: s.name, type: s.type, marks: s.marks })),
        questions: qs.map(q => ({ id: q.PoolQID, section: q.Section, type: q.Type, text: String(q.Question), options: parseOpts_(q.Options),
          correct: q.Correct === '' ? null : Number(q.Correct) - 1, difficulty: q.Difficulty, topic: q.Topic, modelAnswer: q.ModelAnswer,
          status: q.Status, note: q.ModNote, setter: 'Setter ' + (setters.indexOf(lower_(q.SetterEmail)) + 1) }))
      };
    })
  };
}

function r_modDecide(req) {
  const u = staff_(req, ['Moderator']);
  const row = findRow_('Pool', 'PoolQID', req.id);
  if (!row) fail_('Question not found.');
  const q = rowObj_('Pool', row);
  const g = exam_(String(q.GroupID));
  if (!g || reviewersOf_({ Reviewers: g.Moderators }).indexOf(u.email) < 0) fail_('This question is not in an exam you moderate.');
  if (q.UsedBy) fail_('This question has already been used.');
  if (q.Status === 'Draft') fail_('The setter has not submitted this question yet.');
  const decision = req.decision === 'Approve' ? 'Approved' : 'Rejected';
  const note = String(req.note || '').trim().slice(0, 1000);
  if (decision === 'Rejected' && note.length < 3) fail_('Tell the setter what to fix.');
  if (req.difficulty && DIFFS.indexOf(req.difficulty) >= 0 && req.difficulty !== q.Difficulty) update_('Pool', row, { Difficulty: req.difficulty });
  update_('Pool', row, { Status: decision, ModNote: note, ModeratedBy: u.email, ModeratedAt: new Date() });
  return { status: decision };
}

/* =========================================================================
 *  HELPERS
 * ========================================================================= */

function fail_(msg) { throw new Error(/^[A-Z_]+$/.test(msg) ? msg : 'USER:' + msg); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function cache_() { return CacheService.getScriptCache(); }
function lower_(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s)); }
function yes_(v) { return v === true || /^(yes|y|true|1|on)$/i.test(String(v == null ? '' : v).trim()); }
function yn_(v) { return v ? 'Yes' : 'No'; }
function uniq_(a) { return a.filter((x, i) => a.indexOf(x) === i); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function newToken_() { return Utilities.getUuid().replace(/-/g, ''); }
function id_(prefix) { return prefix + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMdd') + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); }
function hex_(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function hash_(pw, salt) {
  let h = String(salt) + '|' + String(pw);
  for (let i = 0; i < CFG.HASH_ROUNDS; i++) h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + String(salt), Utilities.Charset.UTF_8));
  return h;
}
function normRole_(r) {
  const x = String(r);
  return /coe|controller/i.test(x) ? 'CoE' : /setter/i.test(x) ? 'Setter' : /moderator/i.test(x) ? 'Moderator' : 'Reviewer';
}

let LOCK_DEPTH_ = 0;
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('The server is busy. Please try again in a moment.');
  LOCK_DEPTH_++;
  try { return fn(); } finally { LOCK_DEPTH_--; SpreadsheetApp.flush(); lock.releaseLock(); }
}

function toDate_(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`);   // treat as IST
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function ms_(v) { const d = toDate_(v); return d ? d.getTime() : 0; }
function ist_(d, f) { return d ? Utilities.formatDate(d, CFG.TZ, f || 'dd MMM yyyy, hh:mm a') : ''; }

function examState_(ex) {
  const now = Date.now(), s = ms_(ex.StartIST), e = ms_(ex.EndIST);
  if (ex.Status !== 'On') return 'off';
  if (now < s) return 'upcoming';
  if (now > e) return 'closed';
  return 'live';
}

function examOut_(e, counts) {
  const s = toDate_(e.StartIST), en = toDate_(e.EndIST);
  return {
    id: e.ExamID, title: e.Title, description: e.Description, instructions: e.Instructions, code: String(e.AccessCode),
    start: s ? s.getTime() : 0, end: en ? en.getTime() : 0, startIST: ist_(s), endIST: ist_(en),
    startInput: s ? Utilities.formatDate(s, CFG.TZ, "yyyy-MM-dd'T'HH:mm") : '', endInput: en ? Utilities.formatDate(en, CFG.TZ, "yyyy-MM-dd'T'HH:mm") : '',
    duration: Number(e.DurationMin) || 0, status: e.Status === 'On' ? 'On' : 'Off', state: examState_(e),
    reviewers: reviewersOf_(e), camera: yes_(e.Camera), screen: yes_(e.Screen), fullscreen: yes_(e.Fullscreen),
    live: yes_(e.LiveProctor), maxWarnings: Number(e.MaxWarnings) || 0, shuffle: yes_(e.ShuffleQuestions),
    totalMarks: Number(e.TotalMarks) || 0, counts: counts || {},
    courseCode: String(e.CourseCode || ''), credits: e.Credits === '' ? '' : Number(e.Credits), programme: String(e.Programme || ''),
    semester: String(e.Semester || ''), session: String(e.Session || ''), rollPrefix: String(e.RollPrefix || ''),
    bands: bands_(e), registeredOnly: yes_(e.RegisteredOnly),
    expected: Number(e.ExpectedCandidates) || 0, priority: priority_(e), hold: yes_(e.Hold),
    mode: isPool_(e) ? 'Pool' : 'Direct', groupId: groupId_(e), isParent: groupId_(e) === e.ExamID, drawn: !!toDate_(e.DrawnAt),
    moderators: reviewersOf_({ Reviewers: e.Moderators })
  };
}

function attOut_(a) {
  return {
    id: a.AttemptID, examId: a.ExamID, rollNo: String(a.RollNo || ''), name: a.Name, email: a.Email, status: a.Status,
    pct: a.Percentage, grade: a.Grade, gp: a.GradePoint, result: a.Result, resultNo: a.ResultNo || '',
    started: ist_(toDate_(a.StartedAt), 'dd MMM, hh:mm a'), submitted: ist_(toDate_(a.SubmittedAt), 'dd MMM, hh:mm a'),
    submitReason: a.SubmitReason, violations: Number(a.Violations) || 0, mcq: a.MCQScore, written: a.WrittenScore,
    total: a.TotalScore, max: a.MaxScore, reviewer: a.Reviewer, reviewerRemarks: a.ReviewerRemarks,
    coeRemarks: a.CoERemarks, verifiedBy: a.VerifiedBy, verifiedAt: ist_(toDate_(a.VerifiedAt), 'dd MMM, hh:mm a'),
    resultSentAt: ist_(toDate_(a.ResultSentAt), 'dd MMM, hh:mm a')
  };
}

function countsByExam_(atts) {
  const c = {};
  atts.forEach(a => { c[a.ExamID] = c[a.ExamID] || {}; c[a.ExamID][a.Status] = (c[a.ExamID][a.Status] || 0) + 1; });
  return c;
}

function reviewersOf_(ex) { return String((ex && ex.Reviewers) || '').split(/[,;\s]+/).map(lower_).filter(Boolean); }
function access_(u, ex) {
  if (!ex) fail_('Exam not found.');
  if (u.role !== 'CoE' && reviewersOf_(ex).indexOf(u.email) < 0) fail_('This exam is not assigned to you.');
}

function parseOpts_(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  if (s.charAt(0) === '[') { try { return JSON.parse(s).map(String); } catch (e) {} }
  return s.split(/\s*\|\s*|\n/).filter(Boolean);
}

function seededShuffle_(arr, seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ---- Sheet access ---- */

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
const ENSURED_ = {};
function sh_(name) {
  const s = ss_();
  let sh = s.getSheetByName(name);
  if (!sh) { sh = s.insertSheet(name); sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]); sh.setFrozenRows(1); ENSURED_[name] = true; }
  if (!ENSURED_[name] && SCHEMA[name]) {
    ENSURED_[name] = true;   // add any columns a newer version of this script expects
    const cur = head_(sh);
    const miss = SCHEMA[name].filter(k => cur.indexOf(k) < 0);
    if (miss.length) sh.getRange(1, cur.filter(String).length ? cur.length + 1 : 1, 1, miss.length).setValues([miss]);
  }
  return sh;
}
function head_(sh) { return sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String); }

function rows_(name) {
  const sh = sh_(name);
  const lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2) return [];
  const v = sh.getRange(1, 1, lr, lc).getValues();
  const h = v.shift().map(String);
  return v.map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => { if (k) o[k] = r[j]; }); return o; });
}

function rowObj_(name, rowNum) {
  const sh = sh_(name);
  const h = head_(sh);
  const r = sh.getRange(rowNum, 1, 1, h.length).getValues()[0];
  const o = { _row: rowNum };
  h.forEach((k, j) => { if (k) o[k] = r[j]; });
  return o;
}

function findRow_(name, col, val) {
  const sh = sh_(name);
  const j = head_(sh).indexOf(col) + 1;
  const lr = sh.getLastRow();
  if (!j || lr < 2 || val === undefined || val === null || val === '') return 0;
  const v = sh.getRange(2, j, lr - 1, 1).getValues();
  const target = String(val);
  for (let i = 0; i < v.length; i++) if (String(v[i][0]) === target) return i + 2;
  return 0;
}

function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    let s = v.length > 49000 ? v.slice(0, 49000) + ' …[truncated]' : v;
    if (/^[=+\-@]/.test(s)) s = "'" + s;   // never let user text become a formula
    return s;
  }
  return v;
}

function append_(name, objs) {
  if (!Array.isArray(objs)) objs = [objs];
  if (!objs.length) return;
  const sh = sh_(name);
  const h = head_(sh);
  const data = objs.map(o => h.map(k => cell_(o[k])));
  if (LOCK_DEPTH_ > 0) sh.getRange(sh.getLastRow() + 1, 1, data.length, h.length).setValues(data);
  else data.forEach(r => sh.appendRow(r));   // appendRow is atomic: safe when many students write at once
  if (name === 'Exams') examsCacheClear_();
}

/** Update some cells of one row with one read and one write. */
function update_(name, rowNum, patch) {
  if (!rowNum) return;
  const sh = sh_(name);
  const h = head_(sh);
  const idx = Object.keys(patch).map(k => h.indexOf(k)).filter(j => j >= 0);
  if (!idx.length) return;
  const lo = Math.min.apply(null, idx), hi = Math.max.apply(null, idx);
  const rng = sh.getRange(rowNum, lo + 1, 1, hi - lo + 1);
  const vals = rng.getValues()[0].map(cell_);
  Object.keys(patch).forEach(k => { const j = h.indexOf(k); if (j >= 0) vals[j - lo] = cell_(patch[k]); });
  rng.setValues([vals]);
  if (name === 'Exams') examsCacheClear_();
}

/** Rewrite a sheet keeping rows where keep(row) is true, then appending newRows. */
function replaceRows_(name, keep, newRows) {
  const sh = sh_(name);
  const h = head_(sh);
  const data = rows_(name).filter(keep).concat(newRows).map(o => h.map(k => cell_(o[k])));
  const lr = sh.getLastRow();
  if (lr > 1) sh.getRange(2, 1, lr - 1, h.length).clearContent();
  if (data.length) sh.getRange(2, 1, data.length, h.length).setValues(data);
  if (name === 'Exams') examsCacheClear_();
}

function settings_() {
  const c = cache_();
  const hit = c.get('settings');
  if (hit) return JSON.parse(hit);
  const o = {};
  DEFAULT_SETTINGS.forEach(r => o[r[0]] = r[1]);
  rows_('Settings').forEach(r => { if (String(r.Key).trim()) o[String(r.Key).trim()] = String(r.Value).trim(); });
  c.put('settings', JSON.stringify(o), 60);
  return o;
}
function setting_(k) { return settings_()[k] || ''; }
function setSetting_(k, v) {
  const row = findRow_('Settings', 'Key', k);
  if (row) update_('Settings', row, { Value: v }); else append_('Settings', { Key: k, Value: v, Notes: '' });
  cache_().remove('settings');
}

function staffRow_(email) {
  const e = lower_(email);
  if (!e) return null;
  const r = findRow_('Staff', 'Email', e);
  if (r) return rowObj_('Staff', r);
  return rows_('Staff').find(s => lower_(s.Email) === e) || null;   // tolerate mixed-case emails typed into the sheet
}
function exam_(id) { const r = findRow_('Exams', 'ExamID', id); return r ? rowObj_('Exams', r) : null; }
function examByCode_(code) { const c = lower_(code); return c ? examsAll_().find(e => lower_(e.AccessCode) === c) || null : null; }
function questions_(examId) {
  return rows_('Questions').filter(q => q.ExamID === examId).sort((a, b) => (Number(a.Order) || 0) - (Number(b.Order) || 0));
}
function attemptRow_(id) { const r = findRow_('Attempts', 'AttemptID', id); return r ? rowObj_('Attempts', r) : null; }
function answerRows_(attemptId) { return rows_('Answers').filter(a => a.AttemptID === attemptId); }

/* ---- Attempt cache (keeps 5-second ticks off the sheet) ---- */

function attCacheObj_(att) {
  let notice = null;
  try { notice = att.Notice ? JSON.parse(att.Notice) : null; } catch (e) { notice = null; }
  return {
    token: String(att.Token), status: att.Status, examId: att.ExamID, email: att.Email, name: att.Name, deadline: ms_(att.Deadline),
    paused: ms_(att.PausedAt), reason: String(att.PausedReason || ''), eta: ms_(att.ResumeEta), notice: notice
  };
}
function cacheAtt_(att) { cache_().put('att_' + att.AttemptID, JSON.stringify(attCacheObj_(att)), 21600); }
function studentAuth_(req) {
  const id = String(req.attemptId || '');
  let s = cache_().get('att_' + id), a = s ? JSON.parse(s) : null;
  if (!a) { const row = attemptRow_(id); if (!row) fail_('Attempt not found.'); cacheAtt_(row); a = JSON.parse(cache_().get('att_' + id)); }
  if (!req.token || a.token !== String(req.token)) fail_('This exam was opened in another window. Please continue there, or re-open the exam.');
  return a;
}

/* ---- Large values in cache (split into 90 KB chunks) ---- */

function putBig_(key, str, ttl) {
  const n = Math.ceil(str.length / 90000) || 1, o = {};
  for (let i = 0; i < n; i++) o[key + '_' + i] = str.slice(i * 90000, (i + 1) * 90000);
  o[key + '_n'] = String(n);
  cache_().putAll(o, ttl);
}
function getBig_(key) {
  const c = cache_(), n = Number(c.get(key + '_n') || 0);
  if (!n) return '';
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = c.getAll(keys);
  return keys.map(k => got[k] || '').join('');
}
function delBig_(key) {
  const c = cache_(), n = Number(c.get(key + '_n') || 0), keys = [key + '_n'];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  c.removeAll(keys);
}

/* ---- Drive folder for proctoring images ---- */

function examFolder_(examId) {
  const p = PropertiesService.getScriptProperties();
  let rootId = setting_('DRIVE_FOLDER_ID'), root;
  try { root = rootId ? DriveApp.getFolderById(rootId) : null; } catch (e) { root = null; }
  if (!root) {
    root = DriveApp.createFolder('ACRI Exam Proctoring');
    setSetting_('DRIVE_FOLDER_ID', root.getId());
  }
  if (!examId) return root;
  const key = 'FOLDER_' + examId;
  const fid = p.getProperty(key);
  if (fid) { try { return DriveApp.getFolderById(fid); } catch (e) {} }
  return withLockSoft_(() => {
    const again = p.getProperty(key);
    if (again) { try { return DriveApp.getFolderById(again); } catch (e) {} }
    const ex = exam_(examId);
    const f = root.createFolder(examId + (ex ? ' — ' + String(ex.Title).slice(0, 60) : ''));
    p.setProperty(key, f.getId());
    return f;
  });
}
function withLockSoft_(fn) {
  const lock = LockService.getScriptLock();
  const got = lock.tryLock(15000);
  try { return fn(); } finally { if (got) lock.releaseLock(); }
}

function audit_(actor, action, target, detail) {
  try { append_('AuditLog', { Time: new Date(), Actor: actor, Action: action, Target: target, Detail: String(detail || '').slice(0, 500) }); } catch (e) {}
}
