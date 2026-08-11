import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';

/*
 * Flow per user:

 * 1. Login
 * 2. Search Coach
 * 3. Search Coach Details
 * 4. Create Cart
 * 5. Update Cart (lock seat)
 * 6. Book
 *
 * If the current coach has no free seats (or all seats are locked),
 * automatically move to the next coach. When the coach list is exhausted,
 * re-run Search Coach. Continues until booking succeeds (or max rounds).
 */

export const options = {
    scenarios: {
        concurrent_booking: {
            executor: 'per-vu-iterations',
            vus: 500,
            iterations: 1,
            maxDuration: '10m',
            gracefulStop: '30s',
        },
    },
};

const AUTH_URL = 'https://api1.bdtickets.tech:20100';
const BOOKING_URL = 'https://api1.bdtickets.tech:20102';

const JOURNEY_DATE = '2026-08-20';
const ROUTE_IDENTIFIER = 'dhaka-to-bandarban';

const loginSuccess = new Counter('login_success');
const loginFail = new Counter('login_fail');
const bookSuccess = new Counter('book_success');
const bookFail = new Counter('book_fail');

const USERS_CSV = __ENV.USERS_CSV || 'loadtest-users.csv';

const users = new SharedArray('users', function () {
    const text = open(USERS_CSV);
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error(`No users found in ${USERS_CSV}`);

    const headers = lines[0].split(',').map((h) => h.trim());
    const phoneIdx = headers.indexOf('phoneNumber');
    const passIdx = headers.indexOf('password');
    const idIdx = headers.indexOf('userId');
    if (phoneIdx < 0 || passIdx < 0) {
        throw new Error('CSV must have phoneNumber and password columns');
    }

    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < 2) continue;

        const phone = normalizePhone((cols[phoneIdx] || '').trim(), i);
        const password = (cols[passIdx] || '').trim();
        if (!phone || !password) continue;

        parsed.push({
            phoneNumber: phone,
            password: password,
            userId: idIdx >= 0 ? (cols[idIdx] || '').trim() : '',
            email: `loadtest${i}@example.com`,
            firstName: 'Load',
            lastName: `User${i}`,
        });
    }

    if (!parsed.length) throw new Error(`Failed to parse users from ${USERS_CSV}`);
    console.log(`Loaded ${parsed.length} users from ${USERS_CSV}`);
    return parsed;
});

function normalizePhone(raw, rowIndex) {
    let p = String(raw || '').trim();
    if (!p) return '';
    if (/e\+/i.test(p)) return `+${8801700000000 + rowIndex}`;
    if (/^\d+(\.0+)?$/.test(p)) p = String(parseInt(p, 10));
    if (!p.startsWith('+')) p = `+${p}`;
    return p;
}

function requestWithRetry(method, url, body, params, maxAttempts = 5) {
    let res = null;
    const opts = Object.assign({ timeout: '60s' }, params || {});
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (method === 'GET') res = http.get(url, opts);
        else if (method === 'PUT') res = http.put(url, body, opts);
        else res = http.post(url, body, opts);
        if (res.status !== 0) return res;
        sleep(1 + attempt);
    }
    return res;
}

function rotateSeats(seats, vu) {
    if (!seats.length) return seats;
    const offset = (vu - 1) % seats.length;
    return seats.slice(offset).concat(seats.slice(0, offset));
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

export default function () {
    const user = users[(__VU - 1) % users.length];
    sleep(Math.random() * 0.5);

    // ===================================================
    // 1. Login
    // ===================================================

    const authRes = requestWithRetry(
        'POST',
        `${AUTH_URL}/v2/auth`,
        JSON.stringify({
            phoneNumber: user.phoneNumber,
            password: user.password,
            applicationChannel: 'WEB_APP',
        }),
        {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        }
    );

    check(authRes, { '1. Login': (r) => r.status === 200 });
    if (authRes.status !== 200) {
        loginFail.add(1);
        bookFail.add(1);
        console.log(`FAIL 1.Login VU=${__VU} phone=${user.phoneNumber} status=${authRes.status}`);
        return;
    }
    loginSuccess.add(1);

    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${authRes.json('data.access.token')}`,
    };

    let booked = false;
    let ticketNo = null;
    let seatNo = null;
    let coachLabel = null;
    let failReason = 'unknown';

    let didSearch = false;
    let didDetails = false;
    let didCreate = false;
    let didUpdate = false;

    // Loop until booking succeeds: seats gone on a coach → next coach; list empty → re-search

    const maxSearchRounds = 30;
    let searchRound = 0;

    while (!booked && searchRound < maxSearchRounds) {
        searchRound++;

        // -------------------------------------------------
        // 2. Search Coach
        // -------------------------------------------------

        const searchRes = requestWithRetry(
            'POST',
            `${BOOKING_URL}/v2/coaches/search`,
            JSON.stringify({ date: JOURNEY_DATE, identifier: ROUTE_IDENTIFIER }),
            { headers }
        );

        didSearch = true;
        if (searchRes.status !== 200) {
            failReason = `search_${searchRes.status}`;
            sleep(1 + Math.random());
            continue;
        }

        // Do not over-filter by availableSeats — verify real seats in details

        let coaches = (searchRes.json('data') || []).filter((c) => c.inactiveRoute !== 1);
        coaches = shuffle(coaches); // spread users across coaches

        if (!coaches.length) {
            failReason = 'no_coach';
            sleep(2);
            continue;
        }

        for (let c = 0; c < coaches.length && !booked; c++) {
            const coach = coaches[c];
            const coachId = coach.id;
            coachLabel = coach.coachNo || coachId;

            // -------------------------------------------------
            // 3. Search Coach Details
            // -------------------------------------------------

            const detailsRes = requestWithRetry(
                'GET',
                `${BOOKING_URL}/v3/coaches/${coachId}/seats`,
                null,
                { headers }
            );

            if (detailsRes.status !== 200) {
                failReason = `details_${detailsRes.status}`;
                continue;
            }
            didDetails = true;

            const coachData = detailsRes.json('data') || {};
            const boardingPoints = coachData.boardingPoints || [];
            const droppingPoints = coachData.droppingPoints || [];
            let availableSeats = (coachData.seats || []).filter(
                (s) => String(s.status || '').toUpperCase() === 'AVAILABLE'
            );

            if (!boardingPoints.length || !droppingPoints.length || !availableSeats.length) {
                failReason = 'coach_full';
                continue; // → next coach
            }

            availableSeats = shuffle(availableSeats); // random seat choice

            // -------------------------------------------------
            // 4. Create Cart
            // -------------------------------------------------

            const createRes = requestWithRetry(
                'POST',
                `${BOOKING_URL}/v3/carts`,
                JSON.stringify({ bookApplication: 'BUS', applicationChannel: 'WEB_APP' }),
                { headers }
            );

            if (createRes.status !== 201) {
                failReason = `create_cart_${createRes.status}`;
                continue;
            }
            didCreate = true;

            const cartId = createRes.json('data.id');
            const updateUrl = `${BOOKING_URL}/v3/carts/${cartId}`;

            // -------------------------------------------------
            // 5. Update Cart (lock a seat)
            // -------------------------------------------------

            let selectedSeat = null;

            for (let i = 0; i < availableSeats.length; i++) {
                const seat = availableSeats[i];
                const updatePayload = {
                    coachId: coachId,
                    seatIdList: [String(seat.seatId)],
                    boardingPoint: boardingPoints[0].reportingBranchId,
                    droppingPoint: droppingPoints[0].reportingBranchId,
                    cartType: 'DEPARTURE',
                    journeyDate: JOURNEY_DATE,
                    applicationChannel: 'WEB_APP',
                    relatedCarts: [cartId],
                    relatedCartId: cartId,
                    passengerList: [
                        {
                            firstName: user.firstName,
                            lastName: user.lastName,
                            gender: 'MALE',
                            phoneNumber: user.phoneNumber,
                            email: user.email,
                        },
                    ],
                    remove: false,
                    includeTravelInsurance: false,
                };

                const updateRes = requestWithRetry('PUT', updateUrl, JSON.stringify(updatePayload), {
                    headers,
                });

                if (updateRes.status !== 200) continue;

                const body = updateRes.json();
                const errors = body.errors || [];
                const data = body.data || {};

                if (errors.length === 0 && (data.seats || (data.coachSeatList || []).length > 0)) {
                    selectedSeat = seat;
                    didUpdate = true;
                    break;
                }

                // SEAT_BEING_PROCESSED_BY_OTHERS / unavailable → try next seat

            }

            if (!selectedSeat) {
                failReason = 'coach_seats_exhausted';
                continue; // → next coach
            }

            sleep(1 + Math.random());

            // -------------------------------------------------
            // 6. Book
            // -------------------------------------------------

            const bookPayload = { cartId: cartId, applicationChannel: 'WEB_APP' };
            let bookRes = null;
            let bookOk = false;

            for (let b = 1; b <= 5 && !bookOk; b++) {
                bookRes = requestWithRetry(
                    'POST',
                    `${BOOKING_URL}/v3/carts/book`,
                    JSON.stringify(bookPayload),
                    {
                        headers,
                        responseCallback: http.expectedStatuses(200, 201, 400),
                    }
                );

                if (bookRes.status === 200 || bookRes.status === 201) {
                    bookOk = true;
                    break;
                }

                let err = '';
                try {
                    err = JSON.stringify(bookRes.json('errors') || []);
                } catch (e) {
                    err = String(bookRes.body);
                }
                if (err.indexOf('BOOKING_CART_NOT_VALID_YET') === -1) break;
                sleep(1.5);
            }

            if (bookOk) {
                booked = true;
                seatNo = selectedSeat.seatNo;
                try {
                    ticketNo = bookRes.json('data.ticketNo');
                } catch (e) {
                    ticketNo = null;
                }
                failReason = null;
                break;
            }

            failReason = `book_${bookRes ? bookRes.status : 0}`;

            // Seat was selected but book failed → try next coach
            
        }

        if (!booked) {
            sleep(1 + Math.random());
        }
    }

    check(null, { '2. Search Coach': () => didSearch });
    check(null, { '3. Search Coach Details': () => didDetails });
    check(null, { '4. Create Cart': () => didCreate });
    check(null, { '5. Update Cart': () => didUpdate });
    check(null, { '6. Book': () => booked });

    if (booked) {
        bookSuccess.add(1);
        console.log(
            `OK  VU=${__VU} phone=${user.phoneNumber} coach=${coachLabel} seat=${seatNo} ticket=${ticketNo}`
        );
    } else {
        bookFail.add(1);
        console.log(`FAIL VU=${__VU} phone=${user.phoneNumber} reason=${failReason}`);
    }
}

export function handleSummary(data) {
    const loginOk = (data.metrics.login_success && data.metrics.login_success.values.count) || 0;
    const loginBad = (data.metrics.login_fail && data.metrics.login_fail.values.count) || 0;
    const bookOk = (data.metrics.book_success && data.metrics.book_success.values.count) || 0;
    const bookBad = (data.metrics.book_fail && data.metrics.book_fail.values.count) || 0;

    const report = `
============================================================
FLOW: Login → Search Coach → Coach Details → Create Cart → Update Cart → Book
(auto next-coach when seats exhausted; re-search until booked)
============================================================
Login  success : ${loginOk}
Login  failed  : ${loginBad}
Book   success : ${bookOk}
Book   failed  : ${bookBad}
Total  users   : ${loginOk + loginBad}
============================================================
`;

    console.log(report);

    return {
        stdout: report,
        'booking-result.json': JSON.stringify(
            {
                login_success: loginOk,
                login_fail: loginBad,
                book_success: bookOk,
                book_fail: bookBad,
                total_users: loginOk + loginBad,
            },
            null,
            2
        ),
    };
}
