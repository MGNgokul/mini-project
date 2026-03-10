(function(){
  "use strict";

  const USERS_KEY = "skillvaultUsers";
  const SESSION_KEY = "skillvaultUser";
  const ATTEMPTS_KEY = "skillvaultLoginAttempts";
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_MS = 5 * 60 * 1000;

  function safeParse(value, fallback){
    try{
      const parsed = JSON.parse(value);
      return parsed === null ? fallback : parsed;
    }catch{
      return fallback;
    }
  }

  function supportsStorage(){
    try{
      const testKey = "__sv_test__";
      localStorage.setItem(testKey, "1");
      localStorage.removeItem(testKey);
      return true;
    }catch{
      return false;
    }
  }

  function read(key, fallback){
    if(!supportsStorage()){
      return fallback;
    }
    return safeParse(localStorage.getItem(key), fallback);
  }

  function write(key, value){
    if(!supportsStorage()){
      return false;
    }
    try{
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    }catch{
      return false;
    }
  }

  function remove(key){
    if(!supportsStorage()){
      return;
    }
    try{
      localStorage.removeItem(key);
    }catch{
      // Ignore storage failures during cleanup.
    }
  }

  function normalizeEmail(email){
    return String(email || "").trim().toLowerCase();
  }

  function sanitizeUser(user){
    if(!user || typeof user !== "object"){
      return null;
    }
    const email = normalizeEmail(user.email);
    if(!email){
      return null;
    }
    return {
      name: String(user.name || "").trim(),
      email: email,
      password: typeof user.password === "string" ? user.password : "",
      passwordHash: typeof user.passwordHash === "string" ? user.passwordHash : "",
      passwordSalt: typeof user.passwordSalt === "string" ? user.passwordSalt : "",
      activeSessionToken: typeof user.activeSessionToken === "string" ? user.activeSessionToken : ""
    };
  }

  function getUsers(){
    const parsed = read(USERS_KEY, []);
    if(!Array.isArray(parsed)){
      return [];
    }
    return parsed.map(sanitizeUser).filter(Boolean);
  }

  function saveUsers(users){
    return write(USERS_KEY, users);
  }

  function arrayBufferToHex(buffer){
    return Array.from(new Uint8Array(buffer))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function generateSalt(length){
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode.apply(null, bytes));
  }

  async function hashPassword(password, salt){
    const encoded = new TextEncoder().encode(String(password || "") + String(salt || ""));
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    return arrayBufferToHex(hashBuffer);
  }

  function validatePasswordStrength(password){
    return /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{6,}$/.test(password);
  }

  function findUserByEmail(users, email){
    const target = normalizeEmail(email);
    return users.find(user => user.email === target) || null;
  }

  function getAttemptStore(){
    const attempts = read(ATTEMPTS_KEY, {});
    return attempts && typeof attempts === "object" ? attempts : {};
  }

  function saveAttemptStore(attempts){
    write(ATTEMPTS_KEY, attempts);
  }

  function getAttemptState(email){
    const attempts = getAttemptStore();
    const key = normalizeEmail(email);
    const entry = attempts[key];
    if(!entry || typeof entry !== "object"){
      return { count: 0, lockedUntil: 0 };
    }
    const count = Number.isFinite(entry.count) ? entry.count : 0;
    const lockedUntil = Number.isFinite(entry.lockedUntil) ? entry.lockedUntil : 0;
    return { count: Math.max(0, count), lockedUntil: Math.max(0, lockedUntil) };
  }

  function updateAttemptState(email, didFail){
    const key = normalizeEmail(email);
    if(!key){
      return;
    }
    const attempts = getAttemptStore();

    if(!didFail){
      delete attempts[key];
      saveAttemptStore(attempts);
      return;
    }

    const current = getAttemptState(key);
    const nextCount = current.count + 1;
    const nextLockedUntil = nextCount >= MAX_FAILED_ATTEMPTS ? (Date.now() + LOCKOUT_MS) : 0;

    attempts[key] = { count: nextCount, lockedUntil: nextLockedUntil };
    saveAttemptStore(attempts);
  }

  function canAttemptLogin(email){
    const state = getAttemptState(email);
    if(state.lockedUntil <= Date.now()){
      return { allowed: true, remainingMs: 0 };
    }
    return { allowed: false, remainingMs: state.lockedUntil - Date.now() };
  }

  function createSessionToken(){
    if(crypto && typeof crypto.randomUUID === "function"){
      return crypto.randomUUID();
    }
    return generateSalt(24);
  }

  function createSession(user){
    return {
      email: user.email,
      name: user.name || "Student",
      role: "student",
      loginAt: Date.now(),
      loginTime: new Date().toISOString(),
      isLoggedIn: true,
      sessionToken: createSessionToken()
    };
  }

  function getSession(){
    return read(SESSION_KEY, null);
  }

  function saveSession(session){
    return write(SESSION_KEY, session);
  }

  function invalidateSession(){
    const session = getSession();
    if(session && session.email){
      const users = getUsers();
      const user = findUserByEmail(users, session.email);
      if(user){
        user.activeSessionToken = "";
        saveUsers(users);
      }
    }
    remove(SESSION_KEY);
  }

  function isSessionValid(session){
    if(!session || typeof session !== "object"){
      return false;
    }
    if(session.isLoggedIn !== true){
      return false;
    }
    if(!normalizeEmail(session.email)){
      return false;
    }
    if(typeof session.loginAt !== "number"){
      return false;
    }
    if(typeof session.sessionToken !== "string" || session.sessionToken.length < 10){
      return false;
    }

    const age = Date.now() - session.loginAt;
    if(age < 0 || age > SESSION_TTL_MS){
      return false;
    }

    const users = getUsers();
    const user = findUserByEmail(users, session.email);
    if(!user){
      return false;
    }

    return user.activeSessionToken === session.sessionToken;
  }

  function bindAutoLogoutValidation(redirectUrl){
    const target = redirectUrl || "login.html";

    function validateAndRedirect(){
      const session = getSession();
      if(!isSessionValid(session)){
        invalidateSession();
        window.location.replace(target);
      }
    }

    window.addEventListener("storage", function(event){
      if(event.key === SESSION_KEY || event.key === USERS_KEY){
        validateAndRedirect();
      }
    });

    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "visible"){
        validateAndRedirect();
      }
    });
  }

  function attachLogoutHandlers(defaultRedirect){
    const selectors = [
      "[data-logout]",
      ".logout-btn",
      "a[href='login.html'][data-logout-link]"
    ];
    const items = document.querySelectorAll(selectors.join(","));
    items.forEach(function(node){
      node.addEventListener("click", function(event){
        event.preventDefault();
        logout(defaultRedirect);
      });
    });
  }

  function injectFloatingLogout(defaultRedirect){
    if(document.querySelector(".sv-floating-logout") || document.body.getAttribute("data-sv-no-floating-logout") === "true"){
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sv-floating-logout";
    button.textContent = "Logout";
    button.setAttribute("aria-label", "Logout");
    button.addEventListener("click", function(){
      logout(defaultRedirect);
    });

    const style = document.createElement("style");
    style.textContent = ".sv-floating-logout{position:fixed !important;top:16px !important;right:16px !important;z-index:2147483647 !important;border:none;border-radius:999px;padding:10px 16px;background:#e74c3c;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.2)}.sv-floating-logout:hover{background:#c0392b}.sv-floating-logout:focus-visible{outline:2px solid #fff;outline-offset:2px}@media(max-width:600px){.sv-floating-logout{top:auto !important;bottom:14px !important;right:12px !important;padding:9px 12px;font-size:12px}}";

    document.head.appendChild(style);
    document.body.appendChild(button);
  }

  async function verifyPassword(user, password){
    const rawPassword = String(password || "");
    if(user.passwordHash && user.passwordSalt){
      const hash = await hashPassword(rawPassword, user.passwordSalt);
      return hash === user.passwordHash;
    }
    if(user.password){
      return user.password === rawPassword;
    }
    return false;
  }

  async function migrateLegacyPassword(user, users, password){
    if(!user.password || user.passwordHash){
      return;
    }
    const salt = generateSalt(16);
    const hash = await hashPassword(password, salt);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    user.password = "";
    saveUsers(users);
  }

  async function login(email, password){
    if(!supportsStorage()){
      return { ok: false, code: "storage-unavailable", message: "Browser storage is unavailable." };
    }

    const normalizedEmail = normalizeEmail(email);
    const rawPassword = String(password || "");

    if(!normalizedEmail || !rawPassword){
      return { ok: false, code: "missing-fields", message: "Email and password are required." };
    }

    const throttling = canAttemptLogin(normalizedEmail);
    if(!throttling.allowed){
      const seconds = Math.ceil(throttling.remainingMs / 1000);
      return { ok: false, code: "locked", message: "Too many attempts. Try again in " + seconds + "s." };
    }

    const users = getUsers();
    const user = findUserByEmail(users, normalizedEmail);

    if(!user){
      updateAttemptState(normalizedEmail, true);
      return { ok: false, code: "invalid-credentials", message: "Invalid email or password." };
    }

    const isValidPassword = await verifyPassword(user, rawPassword);
    if(!isValidPassword){
      updateAttemptState(normalizedEmail, true);
      return { ok: false, code: "invalid-credentials", message: "Invalid email or password." };
    }

    await migrateLegacyPassword(user, users, rawPassword);

    const session = createSession(user);
    user.activeSessionToken = session.sessionToken;
    saveUsers(users);
    saveSession(session);
    updateAttemptState(normalizedEmail, false);

    return {
      ok: true,
      code: "success",
      message: "Login successful.",
      session: session,
      user: { email: user.email, name: user.name }
    };
  }

  async function register(input){
    if(!supportsStorage()){
      return { ok: false, code: "storage-unavailable", message: "Browser storage is unavailable." };
    }

    const name = String(input && input.name || "").trim();
    const email = normalizeEmail(input && input.email || "");
    const password = String(input && input.password || "");
    const confirmPassword = String(input && input.confirmPassword || "");

    if(!name){
      return { ok: false, code: "name-required", message: "Full name is required." };
    }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){
      return { ok: false, code: "invalid-email", message: "Enter a valid email address." };
    }
    if(!validatePasswordStrength(password)){
      return { ok: false, code: "weak-password", message: "Password must have at least 6 characters, 1 uppercase letter, and 1 number." };
    }
    if(password !== confirmPassword){
      return { ok: false, code: "password-mismatch", message: "Passwords do not match." };
    }

    const users = getUsers();
    if(findUserByEmail(users, email)){
      return { ok: false, code: "email-exists", message: "Email already registered." };
    }

    const salt = generateSalt(16);
    const hash = await hashPassword(password, salt);
    users.push({
      name: name,
      email: email,
      passwordHash: hash,
      passwordSalt: salt,
      password: "",
      activeSessionToken: ""
    });

    const saved = saveUsers(users);
    if(!saved){
      return { ok: false, code: "save-failed", message: "Could not save user data." };
    }

    return { ok: true, code: "success", message: "Registration successful." };
  }

  function requireAuth(redirectUrl){
    const target = redirectUrl || "login.html";
    const session = getSession();

    if(!isSessionValid(session)){
      invalidateSession();
      window.location.replace(target);
      return false;
    }

    if(document.readyState === "loading"){
      document.addEventListener("DOMContentLoaded", function(){
        attachLogoutHandlers(target);
        injectFloatingLogout(target);
      }, { once: true });
    }else{
      attachLogoutHandlers(target);
      injectFloatingLogout(target);
    }
    bindAutoLogoutValidation(target);
    return true;
  }

  function redirectIfAuthenticated(targetUrl){
    const target = targetUrl || "dashboard.html";
    const session = getSession();

    if(isSessionValid(session)){
      window.location.replace(target);
      return true;
    }
    return false;
  }

  function logout(redirectUrl){
    const target = redirectUrl || "login.html";
    invalidateSession();
    window.location.replace(target);
  }

  window.SkillVaultAuth = {
    login: login,
    register: register,
    logout: logout,
    requireAuth: requireAuth,
    redirectIfAuthenticated: redirectIfAuthenticated,
    validatePasswordStrength: validatePasswordStrength
  };

  window.requireAuth = requireAuth;
  window.redirectIfAuthenticated = redirectIfAuthenticated;
  window.logout = logout;
})();
