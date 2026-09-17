// Central place to point every portal at the deployed Worker API.
// Replace the default below with your deployed Worker URL, e.g.
// "https://tuition-management-api.<subdomain>.workers.dev". Any portal's
// Settings page can override this per-browser via localStorage.
(function () {
  const DEFAULT_API_BASE_URL = "https://tuition-management-api.swapniluser100.workers.dev";
  const stored = localStorage.getItem("tms_api_base_url");
  window.API_BASE_URL = stored || DEFAULT_API_BASE_URL;
})();
