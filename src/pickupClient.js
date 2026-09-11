// Client for NYC's in-person appointment scheduler (clerkscheduler.cityofnewyork.us),
// which powers the "Marriage License (in-person)" pickup flow. This is a
// completely different system from Project Cupid: a Salesforce Experience
// Cloud site running the Aura framework, not Unqork — no NYC.ID login, a
// batched-action RPC protocol instead of a plain JSON POST, and its own
// picklist of City Clerk office locations. See src/monitors/pickup.js for the
// monitor strategy that drives this client.

const AURA_ENDPOINT_PATH = '/s/sfsites/aura';

// aura.context/aura.pageURI are tied to the specific deployed Salesforce
// static-resource bundle (the "fwuid" embedded inside aura.context) and can go
// stale on any org release — captured fresh from a live page load rather than
// hardcoded or cached across process restarts, by sniffing the first real
// Aura POST the page itself makes during its own bootstrap.
export async function bootstrapAuraContext(page, entryUrl) {
  let auraContext = null;
  let pageUri = null;
  const onResponse = (res) => {
    const req = res.request();
    if (req.method() !== 'POST' || !/aura\?r=/i.test(res.url()) || /InstrumentationBeacon/.test(res.url())) return;
    try {
      const params = new URLSearchParams(req.postData() || '');
      if (!auraContext && params.get('aura.context')) auraContext = params.get('aura.context');
      if (!pageUri && params.get('aura.pageURI')) pageUri = params.get('aura.pageURI');
    } catch {
      // Malformed postData on some unrelated request — keep waiting for a usable one.
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } finally {
    page.off('response', onResponse);
  }
  if (!auraContext) {
    throw new Error('Could not capture aura.context from the scheduler page bootstrap — page structure may have changed.');
  }
  return { auraContext, pageUri: pageUri || '/s/MarriageLicense' };
}

// Fires the Apex action from inside the page (not a bare Node HTTP client) so
// it carries the session state a real page load establishes — same rationale
// as cupidClient.js's checkAvailability for the virtual monitor.
async function callApexAction(page, { auraContext, pageUri, classname, method, params }) {
  return page.evaluate(
    async ({ endpointPath, auraContext, pageUri, classname, method, params }) => {
      const message = JSON.stringify({
        actions: [{
          id: '1;a',
          descriptor: 'aura://ApexActionController/ACTION$execute',
          callingDescriptor: 'UNKNOWN',
          params: { namespace: '', classname, method, params, cacheable: false, isContinuation: false },
        }],
      });
      const body = new URLSearchParams();
      body.set('message', message);
      body.set('aura.context', auraContext);
      body.set('aura.pageURI', pageUri);
      body.set('aura.token', 'null');
      const r = await fetch(`${endpointPath}?r=1&aura.ApexAction.execute=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      });
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    },
    { endpointPath: AURA_ENDPOINT_PATH, auraContext, pageUri, classname, method, params },
  );
}

// Resolves a human-readable office label (e.g. "Manhattan Office") to its
// current Salesforce record id via the live picklist, rather than hardcoding
// the id — so an id change on Salesforce's side surfaces as a clear "office
// not found" error instead of a silently-wrong query.
export async function fetchOfficeLocationId(page, { auraContext, pageUri, flowType, officeLabel }) {
  const result = await callApexAction(page, {
    auraContext, pageUri,
    classname: 'SCHED_CeremonyFlowController',
    method: 'fetchPicklist',
    params: { flowType },
  });
  const action = result.json?.actions?.[0];
  if (!action || action.state !== 'SUCCESS') {
    throw new Error(`fetchPicklist failed: ${JSON.stringify(action?.error ?? result)}`);
  }
  const options = action.returnValue?.returnValue;
  if (!Array.isArray(options)) {
    throw new Error('fetchPicklist returned an unexpected shape — office list not found.');
  }
  const match = options.find((o) => String(o.label).trim().toLowerCase() === officeLabel.trim().toLowerCase());
  if (!match) {
    const available = options.map((o) => o.label).join(', ');
    throw new Error(`Office "${officeLabel}" not found in picklist. Available: ${available}`);
  }
  return match.value;
}

// Queries a single specific date. isDateChanged+selectedDate is a stateless,
// directly-queryable request (confirmed live: the server answered a
// far-future date immediately with real data — the UI's own min/max-date
// field validation is client-side only, not a server-side horizon cap).
// weekAction-based navigation, by contrast, errored when tried cold — it
// appears to depend on server-side state from a prior call in the same
// session, so it's deliberately not used here.
//
// The server can silently substitute `nextAvailableDate` for a date it won't
// serve directly (e.g. a weekend/closed day) rather than error — callers MUST
// check the response's own `selectedDate` against what was requested before
// trusting the response describes that date, not assume a shifted response is
// an answer about the date that was asked for.
export async function getSlotsForDate(page, { auraContext, pageUri, locationId, selectedDate }) {
  const result = await callApexAction(page, {
    auraContext, pageUri,
    classname: 'SCHED_BookAppointmentController',
    method: 'getSlots',
    params: {
      isDeviceMobile: false,
      isCeremonyFlow: false,
      isLicenseFlow: true,
      isDomesticFlow: false,
      isCertificateOfNonImpediment: false,
      isRecordsRoom: false,
      isMarriageOfficiantRegistration: false,
      isMarriageOfficiant: false,
      isPageLoad: false,
      isDateChanged: true,
      isWeekChanged: false,
      weekAction: null,
      locationId,
      selectedDate,
      selectedSlotId: null,
      selectedSlotData: 'null',
    },
  });
  const action = result.json?.actions?.[0];
  if (!action || action.state !== 'SUCCESS') {
    return { ok: false, status: result.status, error: action?.error ?? result.json };
  }
  return { ok: true, status: result.status, data: action.returnValue?.returnValue };
}
