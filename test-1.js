import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    vus: 1,
    duration: '30s',
};

const AUTH_URL = 'https://api1.bdtickets.tech:20100';
const BOOKING_URL = 'https://api1.bdtickets.tech:20102';

// Same as Insomnia Staging request

const JOURNEY_DATE = '2026-08-19';
const ROUTE_IDENTIFIER = 'dhaka-to-bandarban';

const PHONE = '+8801732636946';
const PASSWORD = 'Tahsin@3092#';
const EMAIL = 'tahsinahmed309203@gmail.com';

function printApiResponse(stepName, method, url, requestBody, res) {
    console.log('\n============================================================');
    console.log(stepName);
    console.log('============================================================');
    console.log('Method :', method);
    console.log('URL    :', url);
    if (requestBody !== null && requestBody !== undefined) {
        console.log('Request Body:');
        console.log(JSON.stringify(requestBody, null, 2));
    }
    console.log('------------------------------------------------------------');
    console.log('Status :', res.status);
    console.log('Response Body:');
    try {
        console.log(JSON.stringify(JSON.parse(res.body), null, 2));
    } catch (e) {
        console.log(res.body);
    }
    console.log('============================================================\n');
}

// Retry on connection drop (status 0) — staging often times out under VU burst

function requestWithRetry(method, url, body, params, maxAttempts = 5) {
    let res = null;
    const opts = Object.assign({ timeout: '60s' }, params || {});
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (method === 'GET') {
            res = http.get(url, opts);
        } else if (method === 'PUT') {
            res = http.put(url, body, opts);
        } else {
            res = http.post(url, body, opts);
        }
        if (res.status !== 0) return res;
        console.log(`Connection failed (status 0) attempt ${attempt}/${maxAttempts}: ${method} ${url}`);
        sleep(1 + attempt);
    }
    return res;
}

// Different VUs start at different seats to reduce SEAT_BEING_PROCESSED_BY_OTHERS races

function rotateSeats(seats, vu, iter) {
    if (!seats.length) return seats;
    const offset = ((vu - 1) + (iter - 1) * 3) % seats.length;
    return seats.slice(offset).concat(seats.slice(0, offset));
}

export default function () {
    // Stagger VU start so Coach Details / seat lock is less simultaneous
    sleep((__VU - 1) * 0.25);

    // ===================================================
    // 1. Generate Token
    // ===================================================

    const authUrl = `${AUTH_URL}/v2/auth`;
    const authPayload = {
        phoneNumber: PHONE,
        password: PASSWORD,
        applicationChannel: 'WEB_APP',
    };

    const authRes = requestWithRetry('POST', authUrl, JSON.stringify(authPayload), {
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
    });

    check(authRes, { '1. Generate Token 200': (r) => r.status === 200 });
    if (authRes.status !== 200) {
        console.log('Generate Token failed:', authRes.status, authRes.body);
        return;
    }

    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${authRes.json('data.access.token')}`,
    };

    // ===================================================
    // 2. Search Coach  (Insomnia: POST /v2/coaches/search)
    // ===================================================

    const searchUrl = `${BOOKING_URL}/v2/coaches/search`;
    const searchPayload = {
        date: JOURNEY_DATE,
        identifier: ROUTE_IDENTIFIER,
    };

    const searchRes = requestWithRetry('POST', searchUrl, JSON.stringify(searchPayload), { headers });

    check(searchRes, { '2. Search Coach 200': (r) => r.status === 200 });
    if (searchRes.status !== 200) {
        console.log('Search Coach failed:', searchRes.status, searchRes.body);
        return;
    }

    const coaches = (searchRes.json('data') || []).filter(
        (c) => (c.availableSeats === undefined || c.availableSeats > 0) && c.inactiveRoute !== 1
    );
    if (!coaches.length) {
        console.log('No coach found in response data.');
        return;
    }

    const coachId = coaches[0].id;

    // ===================================================
    // 3. Coach Details
    // ===================================================

    const coachUrl = `${BOOKING_URL}/v3/coaches/${coachId}/seats`;
    const coachRes = requestWithRetry('GET', coachUrl, null, { headers });

    check(coachRes, { '3. Coach Details 200': (r) => r.status === 200 });
    if (coachRes.status !== 200) {
        console.log('Coach Details failed:', coachRes.status, coachRes.body);
        return;
    }

    const coachData = coachRes.json('data');
    const boardingPoints = coachData.boardingPoints || [];
    const droppingPoints = coachData.droppingPoints || [];
    let availableSeats = (coachData.seats || []).filter(
        (s) => String(s.status || '').toUpperCase() === 'AVAILABLE'
    );

    if (!boardingPoints.length || !droppingPoints.length || !availableSeats.length) {
        console.log('Missing boarding/dropping points or available seats.');
        return;
    }

    availableSeats = rotateSeats(availableSeats, __VU, __ITER);

    // ===================================================
    // 4. Create Cart
    // ===================================================

    const createUrl = `${BOOKING_URL}/v3/carts`;
    const createPayload = {
        bookApplication: 'BUS',
        applicationChannel: 'WEB_APP',
    };

    const createRes = requestWithRetry('POST', createUrl, JSON.stringify(createPayload), { headers });

    check(createRes, { '4. Create Cart 201': (r) => r.status === 201 });
    if (createRes.status !== 201) {
        console.log('Create Cart failed:', createRes.status, createRes.body);
        return;
    }

    const cartId = createRes.json('data.id');

    // ===================================================
    // 5. Update Cart — try seats in VU-rotated order; skip locks
    // ===================================================

    let updateRes = null;
    let selectedSeat = null;
    let updatePayload = null;
    const updateUrl = `${BOOKING_URL}/v3/carts/${cartId}`;
    const maxSeatTries = Math.min(availableSeats.length, 12);

    for (let i = 0; i < maxSeatTries; i++) {
        const seat = availableSeats[i];

        updatePayload = {
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
                    firstName: 'Rahim',
                    lastName: 'Uddin',
                    gender: 'MALE',
                    phoneNumber: PHONE,
                    email: EMAIL,
                },
            ],
            remove: false,
            includeTravelInsurance: false,
        };

        updateRes = requestWithRetry('PUT', updateUrl, JSON.stringify(updatePayload), { headers });

        if (updateRes.status !== 200) {
            sleep(0.3);
            continue;
        }

        const body = updateRes.json();
        const errors = body.errors || [];
        const data = body.data || {};
        const errText = JSON.stringify(errors);

        if (errors.length === 0 && (data.seats || (data.coachSeatList || []).length > 0)) {
            selectedSeat = seat;
            printApiResponse('5. UPDATE CART', 'PUT', updateUrl, updatePayload, updateRes);
            break;
        }

        // Seat locked by another VU — try next seat immediately

        if (errText.indexOf('SEAT_BEING_PROCESSED_BY_OTHERS') !== -1) {
            console.log(`Seat ${seat.seatId} locked, trying next...`);
            continue;
        }

        sleep(0.3);
    }

    check(null, { '5. Update Cart seat selected': () => !!selectedSeat });
    if (!selectedSeat) {
        if (updateRes) {
            printApiResponse('5. UPDATE CART', 'PUT', updateUrl, updatePayload, updateRes);
        }
        console.log('No seat selected.');
        return;
    }

    sleep(2);

    // ===================================================
    // 6. Book
    // ===================================================
    
    const bookUrl = `${BOOKING_URL}/v3/carts/book`;
    const bookPayload = {
        cartId: cartId,
        applicationChannel: 'WEB_APP',
    };

    let bookRes = null;
    let booked = false;

    for (let b = 1; b <= 5 && !booked; b++) {
        bookRes = requestWithRetry('POST', bookUrl, JSON.stringify(bookPayload), {
            headers: headers,
            responseCallback: http.expectedStatuses(200, 201, 400),
        });

        if (bookRes.status === 200 || bookRes.status === 201) {
            booked = true;
            break;
        }

        let err = '';
        try {
            err = JSON.stringify(bookRes.json('errors') || []);
        } catch (e) {
            err = String(bookRes.body);
        }
        if (err.indexOf('BOOKING_CART_NOT_VALID_YET') === -1) break;
        sleep(2);
    }

    printApiResponse('6. BOOK', 'POST', bookUrl, bookPayload, bookRes);

    check(null, { '6. Book 200': () => booked });

    sleep(1);
}
