const J = { "Content-Type": "application/json" };

async function req(method, url, body, isForm) {
  const opts = { method, credentials: "same-origin" };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.headers = J; opts.body = JSON.stringify(body); }
  }
  const r = await fetch(url, opts);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = (data && data.detail) ? (Array.isArray(data.detail) ? data.detail.map(d => d.msg).join(", ") : data.detail) : `HTTP ${r.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

const qs = (o) => {
  const p = new URLSearchParams();
  Object.entries(o || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, v);
  });
  const s = p.toString();
  return s ? "?" + s : "";
};

export const api = {
  // health/meta
  health: () => req("GET", "/api/health"),
  quota: () => req("GET", "/api/quota"),
  plugins: () => req("GET", "/api/plugins"),
  reloadPlugins: () => req("POST", "/api/plugins/reload"),
  // auth
  me: () => req("GET", "/api/auth/me"),
  login: (username, password) => req("POST", "/api/auth/login", { username, password }),
  logout: () => req("POST", "/api/auth/logout"),
  // admin
  adminStatus: () => req("GET", "/api/admin/status"),
  adminSetup: (password) => req("POST", "/api/admin/setup", { password }),
  adminLogin: (username, password) => req("POST", "/api/admin/login", { username, password }),
  changePassword: (old_password, new_password) => req("POST", "/api/admin/change-password", { old_password, new_password }),
  // cases
  cases: () => req("GET", "/api/cases"),
  clusters: () => req("GET", "/api/clusters"),
  casesByCluster: (c) => req("GET", `/api/cases/by-cluster/${encodeURIComponent(c)}`),
  getCase: (id) => req("GET", `/api/cases/${id}`),
  createCase: (file, caseNumber, source = "local") => {
    const fd = new FormData();
    fd.append("file", file); fd.append("source", source); fd.append("case_number", caseNumber || "");
    return req("POST", "/api/cases", fd, true);
  },
  createCaseFolder: (files, caseNumber, source = "local", paths = null) => {
    const fd = new FormData();
    fd.append("case_number", caseNumber || ""); fd.append("source", source);
    files.forEach((f, i) => {
      fd.append("files", f);
      fd.append("paths", (paths && paths[i]) || f._rel || f.webkitRelativePath || f.name);
    });
    return req("POST", "/api/cases/folder", fd, true);
  },
  deleteCase: (id) => req("DELETE", `/api/cases/${id}`),
  deleteAllCases: () => req("DELETE", "/api/cases"),
  jobStatus: (jobId) => req("GET", `/api/jobs/${encodeURIComponent(jobId)}`),
  reclassify: (id) => req("POST", `/api/cases/${id}/reclassify`),
  refreshMetadata: (id) => req("POST", `/api/cases/${id}/refresh_metadata`),
  // components
  componentFiles: (id, comp) => req("GET", `/api/cases/${id}/components/${comp}/files`),
  componentIndex: (id) => req("GET", `/api/cases/${id}/component_index`),
  autosupportFiles: (id) => req("GET", `/api/cases/${id}/autosupport_files`),
  mlogs: (id) => req("GET", `/api/cases/${id}/mlogs`),
  mlogsAnalyze: (id, maxFiles) => req("GET", `/api/cases/${id}/mlogs/analyze${qs({ max_files: maxFiles })}`),
  mlogFamilyAnalyze: (id, family, maxFiles) => req("GET", `/api/cases/${id}/mlogs/family/analyze${qs({ family, max_files: maxFiles })}`),
  componentParse: (id, comp, files) => req("POST", `/api/cases/${id}/components/${comp}/parse`, { files }),
  componentEvents: (id, comp, params) => req("GET", `/api/cases/${id}/components/${comp}/events${qs(params)}`),
  componentGrep: (id, comp, body) => req("POST", `/api/cases/${id}/components/${comp}/grep`, body),
  componentFileContent: (id, comp, path, max_bytes) => req("GET", `/api/cases/${id}/components/${comp}/file_content${qs({ path, max_bytes })}`),
  // case-level
  caseGrep: (id, body) => req("POST", `/api/cases/${id}/grep`, body),
  parsePaths: (id, body) => req("POST", `/api/cases/${id}/parse_paths`, body),
  fileContent: (id, path, max_bytes) => req("GET", `/api/cases/${id}/file_content${qs({ path, max_bytes })}`),
  xmlTable: (id, path, comp, max_rows) => req("GET",
    comp ? `/api/cases/${id}/components/${comp}/xml_table${qs({ path, max_rows })}`
         : `/api/cases/${id}/xml_table${qs({ path, max_rows })}`),
  emsLog: (id, path, comp, max_records) => req("GET",
    comp ? `/api/cases/${id}/components/${comp}/ems_log${qs({ path, max_records })}`
         : `/api/cases/${id}/ems_log${qs({ path, max_records })}`),
  mgwdLog: (id, path, comp, max_records) => req("GET",
    comp ? `/api/cases/${id}/components/${comp}/mgwd_log${qs({ path, max_records })}`
         : `/api/cases/${id}/mgwd_log${qs({ path, max_records })}`),
  sktraceLog: (id, path, comp, max_records) => req("GET",
    comp ? `/api/cases/${id}/components/${comp}/sktrace_log${qs({ path, max_records })}`
         : `/api/cases/${id}/sktrace_log${qs({ path, max_records })}`),
  ifstat: (id, path, comp) => req("GET",
    comp ? `/api/cases/${id}/components/${comp}/ifstat${qs({ path })}`
         : `/api/cases/${id}/ifstat${qs({ path })}`),
  eventsByPaths: (id, params) => req("GET", `/api/cases/${id}/events_by_paths${qs(params)}`),
  search: (id, q) => req("GET", `/api/cases/${id}/search${qs({ q })}`),
  searchContent: (id, params) => req("GET", `/api/cases/${id}/search/content${qs(params)}`),
  searchFilenames: (id, q) => req("GET", `/api/cases/${id}/search/filenames${qs({ q })}`),
  snapshot: (id, prefix) => req("GET", `/api/cases/${id}/snapshot${qs({ prefix })}`),
  snapshotEvents: (id, params) => req("GET", `/api/cases/${id}/snapshot/events${qs(params)}`),
  topology: (id) => req("GET", `/api/cases/${id}/topology`),
  clustersTopology: () => req("GET", "/api/clusters/topology"),
  // cluster aggregation (all nodes of a cluster)
  clusterNodes: (key) => req("GET", `/api/clusters/${encodeURIComponent(key)}/nodes`),
  clusterEms: (key, params) => req("GET", `/api/clusters/${encodeURIComponent(key)}/ems${qs(params)}`),
  clusterSearchContent: (key, params) => req("GET", `/api/clusters/${encodeURIComponent(key)}/search/content${qs(params)}`),
  clusterSearchFilenames: (key, params) => req("GET", `/api/clusters/${encodeURIComponent(key)}/search/filenames${qs(params)}`),
  // stingray
  stingray: (case_num, file_path) => req("POST", "/api/cases/stingray", { case_num, file_path }),
  stingrayInventory: (caseNum) => req("GET", `/api/cases/stingray/${encodeURIComponent(caseNum)}/inventory`),
  stingrayBrowse: (caseNumber, rel = "") => req("GET", `/api/stingray/browse${qs({ case_number: caseNumber, rel })}`),
  stingrayLoad: (caseNumber, paths) => req("POST", "/api/stingray/load", { case_number: caseNumber, paths }),
  // asup
  asupToken: () => req("GET", "/api/asup/token"),
  setAsupToken: (token, submitter) => req("POST", "/api/asup/token", { token, submitter }),
  clearAsupToken: () => req("DELETE", "/api/asup/token"),
  validateAsupToken: () => req("POST", "/api/asup/token/validate"),
  asupFolders: (id) => req("GET", `/api/asup/cases/${id}/folders`),
  asupUpload: (id, body) => req("POST", `/api/asup/cases/${id}/upload`, body),
  asupPackage: (id, body) => req("POST", `/api/asup/cases/${id}/package`, body),
  asupUploadAiq: (id, body) => req("POST", `/api/asup/cases/${id}/upload_aiq`, body),
  asupUploadUrl: () => req("GET", "/api/asup/upload-url"),
  setAsupUploadUrl: (url) => req("POST", "/api/asup/upload-url", { url }),
  // asup download / load
  asupDownloadConfig: () => req("GET", "/api/asup/download/config"),
  setAsupDownloadConfig: (body) => req("POST", "/api/asup/download/config", body),
  asupDownloadList: (body) => req("POST", "/api/asup/download/list", body),
  asupDownloadLoad: (body) => req("POST", "/api/asup/download/load", body),
  // feedback
  submitFeedback: (body) => req("POST", "/api/feedback", body),
  listFeedback: (params) => req("GET", `/api/feedback${qs(params)}`),
  updateFeedback: (fid, status) => req("PATCH", `/api/feedback/${fid}`, { status }),
  deleteFeedback: (fid) => req("DELETE", `/api/feedback/${fid}`),
  // mappings
  mappings: () => req("GET", "/api/mappings"),
  createMapping: (body) => req("POST", "/api/mappings", body),
  deleteMapping: (mid) => req("DELETE", `/api/mappings/${mid}`),
};
