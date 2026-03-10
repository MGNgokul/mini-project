window.SKILLVAULT_REALTIME = {
  enabled: false,
  firebaseConfig: {
    apiKey: "",
    authDomain: "",
    databaseURL: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  },
  basePath: "skillvault/v1",
  syncKeys: [
    "skillvaultSkills",
    "skillvaultRoadmap",
    "profileData",
    "settings",
    "skillvaultUsers"
  ],
  globalKeys: ["skillvaultUsers"],
  debounceMs: 250
};
