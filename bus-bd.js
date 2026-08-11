import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

/**
 * BusBD (Shyamoli staging) load test
 *
 * Flow:
 * 
 *   Home → Search (Dhaka → Cox's Bazar) → Seat View → Seat Select → Book
 *
 * Load model (Bangla requirement):
 * 
 *   - 100 users search together
 *   - 50 users try to select seats
 *   - ~10–20 users are expected to book successfully (contention)
 *   - When seats are taken / booked, users move to the next coach
 *
 * Run:
 * 
 *   k6 run busbd-shyamoli.js
 *   k6 run -e COACH_TYPE=1 -e DEPART_DATE=08/08/2026 busbd-shyamoli.js
 *   k6 run -e BOOK_VUS=20 -e SELECT_VUS=50 -e TOTAL_VUS=100 busbd-shyamoli.js
 *   k6 run -e TOTAL_VUS=10 -e SELECT_VUS=5 -e BOOK_VUS=2 busbd-shyamoli.js   # smoke
 */

const BASE_URL = __ENV.BASE_URL || 'https://staging-busbd.shyamoliparibahan-bd.com';

// Search form uses dd/mm/yyyy; hidden journey_date on result page is yyyy-mm-dd

const DEPART_DATE_FORM = __ENV.DEPART_DATE || '12/08/2026';
const DEPART_DATE_ISO = __ENV.DEPART_DATE_ISO || toIsoDate(DEPART_DATE_FORM);

const FROM_DISTRICT = __ENV.FROM_DISTRICT || '14'; // DHAKA
const TO_DISTRICT = __ENV.TO_DISTRICT || '13'; // COX'S BAZAR
const FROM_TITLE = __ENV.FROM_TITLE || 'DHAKA';
const TO_TITLE = __ENV.TO_TITLE || "COX'S BAZAR";

// 1 = AC, 2 = NonAc, both = alternate by VU

const COACH_TYPE = (__ENV.COACH_TYPE || 'both').toLowerCase();

const TOTAL_VUS = Number(__ENV.TOTAL_VUS || 10);
const SELECT_VUS = Number(__ENV.SELECT_VUS || 6);
const BOOK_VUS = Number(__ENV.BOOK_VUS || 4);
const MAX_COACH_TRIES = Number(__ENV.MAX_COACH_TRIES || 10);
const MAX_SEAT_TRIES = Number(__ENV.MAX_SEAT_TRIES || 6);
const SEARCH_RETRIES = Number(__ENV.SEARCH_RETRIES || 5);

// Spread VU search starts so staging is not stampeded (seconds between VU offsets)

const STAGGER_SEC = Number(__ENV.STAGGER_SEC || 0.6);
const SEARCH_TIMEOUT = __ENV.SEARCH_TIMEOUT || '90s';
const VISIT_HOME = (__ENV.VISIT_HOME || '0') === '1';

export const options = {
  scenarios: {
    concurrent_booking: {
      executor: 'per-vu-iterations',
      vus: TOTAL_VUS,
      iterations: 1,
      maxDuration: '20m',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    search_success: ['count>0'],

    // Staging often flaps under burst; allow retries / partial failure

    http_req_failed: ['rate<0.9'],
  },
};

const searchSuccess = new Counter('search_success');
const searchFail = new Counter('search_fail');
const seatViewSuccess = new Counter('seatview_success');
const seatSelectSuccess = new Counter('seat_select_success');
const seatSelectFail = new Counter('seat_select_fail');
const bookSuccess = new Counter('book_success');
const bookFail = new Counter('book_fail');
const searchDuration = new Trend('search_duration', true);
const seatViewDuration = new Trend('seatview_duration', true);
const bookDuration = new Trend('book_duration', true);

// Don't treat gateway/timeouts as hard http_req_failed during retries

http.setResponseCallback(http.expectedStatuses(200, 302, 400, 409, 500, 502, 503, 504));

function toIsoDate(ddmmyyyy) {
  const parts = String(ddmmyyyy).split('/');
  if (parts.length !== 3) return '2026-08-08';
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function coachTypeForVu(vu) {
  if (COACH_TYPE === '1' || COACH_TYPE === 'ac') return '1';
  if (COACH_TYPE === '2' || COACH_TYPE === 'nonac') return '2';
  return vu % 2 === 0 ? '1' : '2';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function formBody(obj) {
  const parts = [];
  for (const k of Object.keys(obj)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(obj[k] == null ? '' : obj[k])}`);
  }
  return parts.join('&');
}

function htmlHeaders(referer) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: referer || `${BASE_URL}/`,
  };
}

function ajaxHeaders(referer) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: referer || `${BASE_URL}/en_US/seatsearch`,
  };
}

function isTransient(res) {

  // status 0 = timeout / network error in k6

  return !res || res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504;
}

function requestWithRetry(method, url, body, params, maxAttempts) {
  const attempts = maxAttempts || 3;
  let res = null;
  const opts = Object.assign({ timeout: '60s' }, params || {});
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (method === 'GET') res = http.get(url, opts);
    else res = http.post(url, body, opts);
    if (!isTransient(res)) return res;
    if (attempt < attempts) sleep(1.5 * attempt + Math.random());
  }
  return res;
}

function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

function extractCsrf(html) {
  const m = String(html).match(/csrfToken\s*=\s*"([a-f0-9]+)"/i);
  return m ? m[1] : '';
}

function extractJourneyDate(html) {
  const m = String(html).match(/id="journey_date"[^>]*value\s*=\s*"([^"]+)"/i)
    || String(html).match(/name="journey_date"[^>]*value\s*=\s*"([^"]+)"/i);
  return m ? m[1] : DEPART_DATE_ISO;
}

function extractAttr(html, id) {

  // HTML may put value before or after id=

  const re = new RegExp(
    `id="${id}"[^>]*value\\s*=\\s*"([^"]*)"|value\\s*=\\s*"([^"]*)"[^>]*id="${id}"`,
    'i'
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || '') : '';
}

function extractCoaches(html) {
  const coaches = [];
  const re = /id="menuRow_([a-f0-9]{32})"/gi;
  let m;
  const seen = {};
  while ((m = re.exec(html)) !== null) {
    const sku = m[1];
    if (seen[sku]) continue;
    seen[sku] = true;

    // Collect all seat-type fares for this coach (value may appear before id)

    const fares = {};
    const fareRe = new RegExp(
      `(?:id="hidden-seat-type-fare-(\\d+)_${sku}"[^>]*value\\s*=\\s*"([0-9.]+)"|value\\s*=\\s*"([0-9.]+)"[^>]*id="hidden-seat-type-fare-(\\d+)_${sku}")`,
      'gi'
    );
    let fm;
    while ((fm = fareRe.exec(html)) !== null) {
      const typeId = fm[1] || fm[4];
      const fare = fm[2] || fm[3];
      if (typeId && fare) fares[typeId] = fare;
    }

    const seatTypeIds = Object.keys(fares);
    const seatTypeId = seatTypeIds.length ? seatTypeIds[0] : '2';
    const seatFare = fares[seatTypeId] || '0.00';

    const journeyTime = extractAttr(html, `hdn-departuretime_${sku}`);

    const availRe = new RegExp(`id="availablediv_${sku}"[^>]*>\\s*(\\d+)`, 'i');
    const availMatch = html.match(availRe);
    const available = availMatch ? Number(availMatch[1]) : 0;

    coaches.push({
      cc_sku: sku,
      seatTypeId,
      seatFare,
      fares,
      journeyTime,
      available,
    });
  }
  return coaches;
}

function fareForSeat(coach, seat) {
  if (!coach || !coach.fares) return 0;
  const typeId = seat && seat.seatTypeId ? String(seat.seatTypeId) : '';

  // Site JS: $('#hidden-seat-type-fare-' + seat_type_id + '_' + cc_sku).val()
  // Must match the seat's real type — never invent type "2"

  if (typeId && coach.fares[typeId]) return Number(coach.fares[typeId]);

  // Seat with blank type: use the only configured fare if unambiguous

  const keys = Object.keys(coach.fares);
  if (!typeId && keys.length === 1) return Number(coach.fares[keys[0]]);
  return 0;
}

/** Match site JS: pick ccharge[i].charge_amount where fare is in [start_range, end_range] */

function serviceChargeForFare(ccharge, seatFare) {
  const fare = Number(seatFare) || 0;
  if (!ccharge || !fare) return 0;

  const rows = Array.isArray(ccharge) ? ccharge : [ccharge];
  let scharge = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const start = Number(row.start_range);
    const end = Number(row.end_range);
    if (fare >= start && fare <= end) {
      const amount = Number(row.charge_amount) || 0;

      // perticket_or_percent: "1" / true → percent of fare

      if (String(row.perticket_or_percent) === '1') {
        scharge = (fare * amount) / 100;
      } else {
        scharge = amount;
      }
    }
  }
  return scharge;
}

function bankChargeForFare(payment, seatFare) {
  const fare = Number(seatFare) || 0;
  const applied = Number(payment && payment.applied_charge) || 0;

  // Site: bank_charge += ceil((applied_charge * seat_fare) / 100)

  return Math.ceil((applied * fare) / 100);
}

function availableSeats(seatData, coach) {
  const details = (seatData && seatData.seatstructure_details) || {};
  const sold = (seatData && seatData.coach_seatstatus) || {};
  const temp = (seatData && seatData.temporary_booked) || {};
  const seats = [];
  const fareTypes = (coach && coach.fares) || {};
  const fareTypeKeys = Object.keys(fareTypes);

  for (const key of Object.keys(details)) {
    const s = details[key];
    if (!s || !s.seat_structure_details_id) continue;
    const id = String(s.seat_structure_details_id);
    if (sold[id] || temp[id]) continue; // Booked / temporary hold

    const rawType = s.seat_type_id;
    const seatTypeId =
      rawType != null && String(rawType).trim() !== '' ? String(rawType) : '';

    // Only keep seats we can price (avoids CODE #102 DOES NOT HAVE VALID FARE)

    if (seatTypeId && !fareTypes[seatTypeId]) continue;
    if (!seatTypeId && fareTypeKeys.length !== 1) continue;

    seats.push({
      id,
      seatNo: s.seat_no,
      seatTypeId: seatTypeId || fareTypeKeys[0],
    });
  }
  return seats;
}

function firstPoint(mapObj) {
  if (!mapObj) return null;
  const keys = Object.keys(mapObj);
  if (!keys.length) return null;
  const p = mapObj[keys[0]];
  return {
    id: String(p.reporting_branch_id || keys[0]),
    title: p.counter_name || '',
  };
}

function visitHome() {
  const res = requestWithRetry(
    'GET',
    `${BASE_URL}/`,
    null,
    {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      tags: { name: '0_Home' },
      timeout: '45s',
    },
    3
  );
  return res && res.status === 200;
}

function searchCoaches(coachType) {
  const payload = formBody({
    searchmenu_leavingform: FROM_DISTRICT,
    searchmenu_goingto: TO_DISTRICT,
    searchmenu_departingon: DEPART_DATE_FORM,
    searchmenu_coachtype: coachType,
    leavingFormTitle: FROM_TITLE,
    goingToTitle: TO_TITLE,
    searchmenu_submitbutton: 'Search',
  });

  const start = Date.now();
  const res = requestWithRetry(
    'POST',
    `${BASE_URL}/en_US/seatsearch`,
    payload,
    {
      headers: htmlHeaders(`${BASE_URL}/`),
      tags: { name: '1_Search' },
      timeout: SEARCH_TIMEOUT,
    },
    SEARCH_RETRIES
  );
  searchDuration.add(Date.now() - start);

  const ok = check(res, {
    '1. Search status 200': (r) => r && r.status === 200,
    '1. Search has coaches or empty result': (r) =>
      r && r.body && (r.body.indexOf('menuRow_') >= 0 || r.body.indexOf('onlinesearch') >= 0),
  });

  if (!ok || !res || res.status !== 200) {
    searchFail.add(1);
    const status = res ? res.status : 0;
    const snippet =
      res && res.body ? String(res.body).replace(/\s+/g, ' ').slice(0, 80) : '';
    console.log(`FAIL Search detail status=${status} body=${snippet}`);
    return null;
  }

  searchSuccess.add(1);
  const coaches = extractCoaches(res.body).filter(
    (c) => c.available > 0 && c.fares && Object.keys(c.fares).length > 0
  );
  return {
    html: res.body,
    csrf: extractCsrf(res.body),
    journeyDate: extractJourneyDate(res.body),
    coaches,
  };
}

function seatView(ccSku, journeyDate, opts) {
  const options = opts || {};
  const payload = formBody({
    cc_sku: ccSku,
    journey_date: journeyDate || DEPART_DATE_FORM,
    to_district: TO_DISTRICT,
    from_district: FROM_DISTRICT,
  });

  const start = Date.now();
  const res = requestWithRetry(
    'POST',
    `${BASE_URL}/en_US/ajax/onlineseatbooking/seatview`,
    payload,
    {
      headers: ajaxHeaders(),
      tags: { name: options.tag || '2_SeatView' },
      timeout: '60s',
    },
    options.retries != null ? options.retries : 3
  );
  if (!options.quiet) seatViewDuration.add(Date.now() - start);

  const data = safeJson(res);
  const ok = check(res, {
    '2. SeatView status 200': (r) => r && r.status === 200,
    '2. SeatView message success': () => data && data.message === 'success',
  });

  if (!ok || !data || data.message !== 'success') return null;
  if (!options.quiet) seatViewSuccess.add(1);
  return data;
}

function checkSeatAvailability(csrf, ccSku, journeyDate, seatIds) {
  const payload = formBody({
    csrfToken: csrf,
    cc_sku: ccSku,
    journey_date: journeyDate,
    seats: seatIds,
  });

  const res = requestWithRetry(
    'POST',
    `${BASE_URL}/en_US/ajax/onlineseatbooking/checkseatavailability`,
    payload,
    {
      headers: ajaxHeaders(),
      tags: { name: '3_SeatSelect' },
      timeout: '45s',
    },
    2
  );

  const data = safeJson(res);
  const available = res && res.status === 200 && (!data || data.message !== 'error');
  check(null, { '3. Seat Select / Availability': () => available });
  return { ok: available, data, body: res && res.body };
}

function bookSeat(params) {
  const payloadObj = {
    csrfToken: params.csrf,
    party: 'busbd',
    currentCoachNo: '',
    currentCoachType: '',
    leavingFromTitle: FROM_TITLE,
    goingToTitle: TO_TITLE,
    bus_id: '',
    seat_count: params.seatCount,
    seats: params.seats,
    seats_title: params.seatsTitle,
    seats_fare: params.seatsFare,
    amount: params.amount,
    servicecharge: params.serviceCharge || '0.00',
    bankcharge: params.bankCharge || '0',
    name: params.name,
    mobile_prefix: '88',
    mobile: params.mobile,
    gender: 'Male',
    age: '',
    buyer_address: '',
    buyer_passport: '',
    additional_passenger_name: '',
    additional_passenger_passport: '',
    nationality_id: 'bangladesh',
    nationality_title: 'Bangladesh',
    bording_point: params.boardingId,
    bording_point_title: params.boardingTitle,
    droppingpoint: params.droppingId,
    droppingpoint_title: params.droppingTitle,
    payment_method: params.paymentMethodId,
    payment_method_title: params.paymentMethodTitle,
    journey_date: params.journeyDate,
    journey_time: params.journeyTime,
    from_district: FROM_DISTRICT,
    to_district: TO_DISTRICT,
    cc_sku: params.ccSku,
    termconditions: 'agreed',
  };
  const payload = formBody(payloadObj);

  const start = Date.now();

  // Step 1: seatissue — validates booking payload (UI then goes to payment)

  const res = requestWithRetry(
    'POST',
    `${BASE_URL}/en_US/ajax/onlineseatbooking/seatissue`,
    payload,
    {
      headers: ajaxHeaders(),
      tags: { name: '4_Book_Issue' },
      timeout: '60s',
    },
    2
  );

  const data = safeJson(res);
  const issueOk =
    res &&
    res.status === 200 &&
    data &&
    data.message !== 'error' &&
    !(data.message_details && String(data.message_details).toUpperCase().indexOf('ERROR') >= 0);

  if (!issueOk) {
    bookDuration.add(Date.now() - start);
    check(null, { '4. Book': () => false });
    return {
      ok: false,
      locked: false,
      data,
      body: res && res.body,
      status: res ? res.status : 0,
      stage: 'seatissue',
    };
  }

  // Step 2: payment init — this is what actually creates the seat hold/transaction.
  // Without this, UI still shows the seat as available (exact issue you saw).

  const payMethod = String(params.paymentMethodId || '');
  const track = String(params.paymentTrack || '').toLowerCase();
  let payUrl = `${BASE_URL}/en_US/onlineseatbooking/confirm`;
  let payTag = '4_Book_Confirm';
  if (payMethod === '13' || track.indexOf('bkash') >= 0) {
    payUrl = `${BASE_URL}/en_US/ajax/onlineseatbooking/bkash/bkashseatbooking`;
    payTag = '4_Book_Bkash';
  }

  const payPayload = formBody(
    Object.assign({}, payloadObj, {
      buyer_net_fare: params.amount,
      journey_timestamp: '0',
    })
  );

  const payRes = requestWithRetry(
    'POST',
    payUrl,
    payPayload,
    {
      headers: ajaxHeaders(`${BASE_URL}/en_US/seatsearch`),
      tags: { name: payTag },
      timeout: '60s',
      responseCallback: http.expectedStatuses(200, 302, 400, 409, 500),
    },
    2
  );

  const payData = safeJson(payRes);
  const isBkash = payMethod === '13' || track.indexOf('bkash') >= 0;
  const payOk =
    payRes &&
    (payRes.status === 200 || payRes.status === 302) &&
    (isBkash
      ? !!(payData && payData.message === 'success')
      : !payData || payData.message !== 'error');

  // Step 3: verify seat is held/sold in seatview (source of truth for UI lock)

  let locked = false;
  let verify = null;
  if (payOk) {
    sleep(0.3);
    verify = seatView(params.ccSku, DEPART_DATE_FORM, {
      quiet: true,
      tag: '4_Book_Verify',
      retries: 2,
    });
    if (verify) {
      const sold = verify.coach_seatstatus || {};
      const temp = verify.temporary_booked || {};
      const seatId = String(params.seats);
      locked = !!(sold[seatId] || temp[seatId]);
    }
  }

  bookDuration.add(Date.now() - start);
  const ok = payOk && locked;
  check(null, { '4. Book locked in seatview': () => ok });

  return {
    ok,
    locked,
    payOk,
    data: payData || data,
    body: payRes && payRes.body,
    status: payRes ? payRes.status : 0,
    stage: locked ? 'locked' : payOk ? 'payment_ok_not_locked' : 'payment_failed',
    txnId: payData && payData.onlineseatbookingtransaction_id,
  };
}

export default function () {
  const vu = __VU;
  const doSelect = vu <= SELECT_VUS;
  const doBook = vu <= BOOK_VUS;
  const coachType = coachTypeForVu(vu);

  // Spread starts: VU1 immediate, VU100 ~60s later (default) + small jitter

  sleep((vu - 1) * STAGGER_SEC + Math.random() * 0.8);

  if (VISIT_HOME) {
    group('Home', function () {
      visitHome();
    });
    sleep(0.2 + Math.random() * 0.3);
  }

  let search;
  group('Search', function () {
    search = searchCoaches(coachType);
  });

  if (!search) {
    console.log(`FAIL Search VU=${vu} coachType=${coachType}`);
    return;
  }

  const coaches = shuffle(search.coaches);
  if (!coaches.length) {
    console.log(`WARN VU=${vu} search ok but no priced coaches (type=${coachType})`);
    if (doSelect) seatSelectFail.add(1);
    if (doBook) bookFail.add(1);
    return;
  }

  console.log(
    `OK Search VU=${vu} type=${coachType} coaches=${coaches.length} select=${doSelect} book=${doBook}`
  );

  // Search-only users stop here

  if (!doSelect) {
    sleep(0.5 + Math.random());
    return;
  }

  let selected = false;
  let booked = false;
  let lastReason = 'no_seat';

  const coachesToTry = coaches.slice(0, Math.min(MAX_COACH_TRIES, coaches.length));

  // Prefer form date for seatview (matches site JS); fall back to ISO from page

  const seatJourneyDate = DEPART_DATE_FORM;
  const bookJourneyDate = search.journeyDate || DEPART_DATE_ISO;

  for (let i = 0; i < coachesToTry.length && !booked; i++) {
    const coach = coachesToTry[i];
    sleep(0.2 + Math.random() * 0.4);

    let seatData;
    group('SeatView', function () {
      seatData = seatView(coach.cc_sku, seatJourneyDate);
    });

    if (!seatData) {
      lastReason = 'seatview_failed';
      continue;
    }

    // Only seats whose seat_type_id has a configured fare (fixes CODE #102)

    const seats = shuffle(availableSeats(seatData, coach));
    if (!seats.length) {
      lastReason = 'no_priced_seats';
      continue;
    }

    const boarding = firstPoint(seatData.bording_points);
    const dropping = firstPoint(seatData.dropping_points);
    if (!boarding || !dropping) {
      lastReason = 'no_boarding_dropping';
      continue;
    }

    const banks = seatData.banks_info || [];

    // Prefer bKash when present (stable on staging)

    let payment = null;
    for (let bi = 0; bi < banks.length; bi++) {
      if (String(banks[bi].available_id) === '13') {
        payment = banks[bi];
        break;
      }
    }
    if (!payment) payment = banks[0];
    if (!payment) {
      payment = {
        available_id: '13',
        available_name: 'bKash Payment',
        applied_charge: 2,
        btrackcode: 'Bkash',
      };
    }

    const seatsToTry = seats.slice(0, Math.min(MAX_SEAT_TRIES, seats.length));

    for (let s = 0; s < seatsToTry.length && !booked; s++) {
      const seat = seatsToTry[s];
      const fare = fareForSeat(coach, seat);
      if (!fare || fare <= 0) {
        lastReason = `invalid_fare_type_${seat.seatTypeId}`;
        continue;
      }

      sleep(0.1 + Math.random() * 0.25);

      let avail;
      group('SeatSelect', function () {
        avail = checkSeatAvailability(
          search.csrf,
          coach.cc_sku,
          bookJourneyDate,
          seat.id
        );
      });

      if (!avail.ok) {
        lastReason = 'seat_not_available';
        continue;
      }

      if (!selected) {
        selected = true;
        seatSelectSuccess.add(1);
      }
      console.log(
        `OK SeatSelect VU=${vu} coach=${coach.cc_sku.slice(0, 8)} seat=${seat.seatNo} type=${seat.seatTypeId} fare=${fare.toFixed(2)}`
      );

      // Select-only users stop after a successful availability lock

      if (!doBook) {
        break;
      }

      const serviceCharge = serviceChargeForFare(seatData.ccharge, fare);
      const bankCharge = bankChargeForFare(payment, fare);
      const mobile = `017${String(10000000 + vu).slice(-8)}`;

      let bookRes;
      group('Book', function () {
        bookRes = bookSeat({
          csrf: search.csrf,
          ccSku: coach.cc_sku,
          seatCount: 1,
          seats: seat.id,
          seatsTitle: seat.seatNo,
          seatsFare: fare.toFixed(2),
          amount: fare.toFixed(2),
          serviceCharge: serviceCharge.toFixed(2),
          bankCharge: String(bankCharge),
          name: `Load User ${vu}`,
          mobile,
          boardingId: boarding.id,
          boardingTitle: boarding.title,
          droppingId: dropping.id,
          droppingTitle: dropping.title,
          paymentMethodId: String(payment.available_id),
          paymentMethodTitle: payment.available_name,
          paymentTrack: payment.btrackcode || '',
          journeyDate: bookJourneyDate,
          journeyTime: coach.journeyTime,
        });
      });

      if (bookRes.ok) {
        booked = true;
        bookSuccess.add(1);
        console.log(
          `OK Book VU=${vu} coach=${coach.cc_sku.slice(0, 8)} seat=${seat.seatNo} fare=${fare.toFixed(2)} scharge=${serviceCharge.toFixed(2)} locked=true txn=${bookRes.txnId || '-'} payment=${payment.available_name}`
        );
        break;
      }

      lastReason =
        (bookRes.data && (bookRes.data.message_details || bookRes.data.message)) ||
        `book_failed_${bookRes.stage || bookRes.status}`;
      console.log(
        `FAIL Book attempt VU=${vu} seat=${seat.seatNo} stage=${bookRes.stage} locked=${bookRes.locked} reason=${lastReason}`
      );
      
      // Fare / service-charge validation errors — move to next coach

      const detail = String(lastReason).toUpperCase();
      if (
        detail.indexOf('VALID FARE') >= 0 ||
        detail.indexOf('CODE #102') >= 0 ||
        detail.indexOf('SERVICE CHARGE') >= 0 ||
        detail.indexOf('CODE #9001') >= 0
      ) {
        break;
      }
    }

    if (selected && !doBook) break;
  }

  if (!selected) {
    seatSelectFail.add(1);
    console.log(`FAIL SeatSelect VU=${vu} reason=${lastReason}`);
  }

  if (doBook && !booked) {
    bookFail.add(1);
    console.log(`FAIL Book VU=${vu} reason=${lastReason}`);
  }

  sleep(0.5 + Math.random());
}

export function handleSummary(data) {
  const get = (name) =>
    (data.metrics[name] && data.metrics[name].values && data.metrics[name].values.count) || 0;

  const report = `
============================================================
BusBD Shyamoli Staging — Search / Seat Select / Book
URL     : ${BASE_URL}
Route   : ${FROM_TITLE} → ${TO_TITLE}
Date    : ${DEPART_DATE_FORM} (${DEPART_DATE_ISO})
VUs     : ${TOTAL_VUS} search | ${SELECT_VUS} select | ${BOOK_VUS} book
============================================================
Search     success : ${get('search_success')}
Search     failed  : ${get('search_fail')}
SeatView   success : ${get('seatview_success')}
SeatSelect success : ${get('seat_select_success')}
SeatSelect failed  : ${get('seat_select_fail')}
Book       success : ${get('book_success')}
Book       failed  : ${get('book_fail')}
============================================================
`;

  console.log(report);
  return {
    stdout: report,
    'busbd-result.json': JSON.stringify(
      {
        search_success: get('search_success'),
        search_fail: get('search_fail'),
        seatview_success: get('seatview_success'),
        seat_select_success: get('seat_select_success'),
        seat_select_fail: get('seat_select_fail'),
        book_success: get('book_success'),
        book_fail: get('book_fail'),
      },
      null,
      2
    ),
  };
}
