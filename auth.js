(function(){
  const SESSION_KEY = "skillvaultUser";
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

  function safeParse(value){
    try{
      return JSON.parse(value);
    }catch{
      return null;
    }
  }

  function getSession(){
    return safeParse(localStorage.getItem(SESSION_KEY));
  }

  function normalizeSession(session){
    if(!session || typeof session !== "object"){
      return null;
    }

    if(typeof session.loginAt === "number"){
      return session;
    }

    if(typeof session.loginTime === "string"){
      const parsed = Date.parse(session.loginTime);
      if(Number.isFinite(parsed)){
        session.loginAt = parsed;
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        return session;
      }
    }

    return session;
  }

  function isSessionValid(session){
    const normalized = normalizeSession(session);
    if(!normalized){
      return false;
    }

    if(normalized.isLoggedIn !== true){
      return false;
    }

    if(typeof normalized.email !== "string" || normalized.email.trim() === ""){
      return false;
    }

    if(typeof normalized.loginAt !== "number"){
      return false;
    }

    const age = Date.now() - normalized.loginAt;
    return age >= 0 && age <= SESSION_TTL_MS;
  }

  window.requireAuth = function(redirectUrl){
    const target = redirectUrl || "login.html";
    const session = getSession();

    if(!isSessionValid(session)){
      localStorage.removeItem(SESSION_KEY);
      window.location.replace(target);
      return false;
    }

    return true;
  };

  window.redirectIfAuthenticated = function(targetUrl){
    const target = targetUrl || "dashboard.html";
    const session = getSession();

    if(isSessionValid(session)){
      window.location.replace(target);
      return true;
    }

    return false;
  };

  window.logout = function(redirectUrl){
    const target = redirectUrl || "login.html";
    localStorage.removeItem(SESSION_KEY);
    window.location.replace(target);
  };
})();
