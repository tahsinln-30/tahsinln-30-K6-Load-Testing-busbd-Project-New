import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    vus: 100,
    duration: '30s',
};

const AUTH_URL = 'https://api1.bdtickets.tech:20100';
const BOOKING_URL = 'https://api1.bdtickets.tech:20102';

// Same as Insomnia Staging request

const JOURNEY_DATE = '2026-08-20';
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

function rotateSeats(seats, vu, iter) {
    if (!seats.length) return seats;
    const offset = ((vu - 1) + (iter - 1) * 3) % seats.length;
    return seats.slice(offset).concat(seats.slice(0, offset));
}

function searchCoaches(headers) {
    const searchUrl = `${BOOKING_URL}/v2/coaches/search`;
    const searchPayload = {
        date: JOURNEY_DATE,
        identifier: ROUTE_IDENTIFIER,
    };

    const searchRes = requestWithRetry('POST', searchUrl, JSON.stringify(searchPayload), { headers });
    if (searchRes.status !== 200) {
        console.log('Search Coach failed:', searchRes.status, searchRes.body);
        return { ok: false, coaches: [], res: searchRes };
    }

    const coaches = (searchRes.json('data') || []).filter(
        (c) => (c.availableSeats === undefined || c.availableSeats > 0) && c.inactiveRoute !== 1
    );
    return { ok: true, coaches, res: searchRes };
}

function tryBookOnCoach(headers, coachId) {

    // 3. Coach Details

    const coachUrl = `${BOOKING_URL}/v3/coaches/${coachId}/seats`;
    const coachRes = requestWithRetry('GET', coachUrl, null, { headers });
    if (coachRes.status !== 200) {
        console.log(`Coach Details failed for ${coachId}:`, coachRes.status, coachRes.body);
        return { booked: false, coachOk: false, seatOk: false, bookOk: false, coachRes, updateRes: null, bookRes: null };
    }

    const coachData = coachRes.json('data');
    const boardingPoints = coachData.boardingPoints || [];
    const droppingPoints = coachData.droppingPoints || [];
    let availableSeats = (coachData.seats || []).filter(
        (s) => String(s.status || '').toUpperCase() === 'AVAILABLE'
    );

    if (!boardingPoints.length || !droppingPoints.length || !availableSeats.length) {
        console.log(`Coach ${coachId}: no available seats / boarding points. Moving to next coach.`);
        return { booked: false, coachOk: true, seatOk: false, bookOk: false, coachRes, updateRes: null, bookRes: null };
    }

    availableSeats = rotateSeats(availableSeats, __VU, __ITER);
    console.log(`Coach ${coachId}: ${availableSeats.length} available seats. Trying...`);

    // 4. Create Cart

    const createUrl = `${BOOKING_URL}/v3/carts`;
    const createPayload = {
        bookApplication: 'BUS',
        applicationChannel: 'WEB_APP',
    };
    const createRes = requestWithRetry('POST', createUrl, JSON.stringify(createPayload), { headers });
    if (createRes.status !== 201) {
        console.log('Create Cart failed:', createRes.status, createRes.body);
        return { booked: false, coachOk: true, seatOk: false, bookOk: false, coachRes, updateRes: null, bookRes: null };
    }

    const cartId = createRes.json('data.id');
    const updateUrl = `${BOOKING_URL}/v3/carts/${cartId}`;

    // 5. Update Cart — try every available seat on this coach

    let updateRes = null;
    let selectedSeat = null;
    let updatePayload = null;

    for (let i = 0; i < availableSeats.length; i++) {
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

        if (errText.indexOf('SEAT_BEING_PROCESSED_BY_OTHERS') !== -1) {
            console.log(`Seat ${seat.seatNo || seat.seatId} locked, trying next...`);
            continue;
        }

        sleep(0.3);
    }

    if (!selectedSeat) {
        console.log(`Coach ${coachId}: all seats unavailable/locked. Moving to next coach.`);
        return { booked: false, coachOk: true, seatOk: false, bookOk: false, coachRes, updateRes, bookRes: null };
    }

    sleep(2);

    // 6. Book

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

    if (booked) {
        printApiResponse('6. BOOK', 'POST', bookUrl, bookPayload, bookRes);
    } else {
        console.log(`Coach ${coachId}: book failed after seat select. Moving to next coach.`);
    }

    return {
        booked,
        coachOk: true,
        seatOk: !!selectedSeat,
        bookOk: booked,
        coachRes,
        updateRes,
        bookRes,
    };
}

export default function () {
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

    // Loop coaches until one seat is selected + booked successfully

    let booked = false;
    let lastCoachOk = false;
    let lastSeatOk = false;
    let lastSearchOk = false;
    let searchRound = 0;
    const maxSearchRounds = 10;

    while (!booked && searchRound < maxSearchRounds) {
        searchRound++;

        // ===================================================
        // 2. Search Coach
        // ===================================================

        console.log(`\n>>> Search round ${searchRound}: looking for coaches...`);
        const search = searchCoaches(headers);
        lastSearchOk = search.ok;
        check(search.res, { '2. Search Coach 200': (r) => r.status === 200 });

        if (!search.ok || !search.coaches.length) {
            console.log('No coach with available seats. Re-searching...');
            sleep(2);
            continue;
        }

        console.log(`Found ${search.coaches.length} coach(es). Will try each until book succeeds.`);

        for (let c = 0; c < search.coaches.length; c++) {
            const coach = search.coaches[c];
            const coachLabel = coach.coachNo || coach.id;
            console.log(`\n>>> Trying coach ${c + 1}/${search.coaches.length}: ${coachLabel} (${coach.id})`);

            const result = tryBookOnCoach(headers, coach.id);
            lastCoachOk = result.coachOk || lastCoachOk;
            lastSeatOk = result.seatOk || lastSeatOk;

            if (result.booked) {
                booked = true;
                check(result.coachRes, { '3. Coach Details 200': (r) => r.status === 200 });
                check(null, { '5. Update Cart seat selected': () => result.seatOk });
                check(null, { '6. Book 200': () => result.bookOk });
                break;
            }

            // Current coach exhausted / failed — continue to next coach
            
            sleep(0.5);
        }

        if (!booked) {
            console.log('All coaches in this search exhausted. Searching again for next available coaches...');
            sleep(2);
        }
    }

    if (!booked) {
        check(null, { '3. Coach Details 200': () => lastCoachOk });
        check(null, { '5. Update Cart seat selected': () => lastSeatOk });
        check(null, { '6. Book 200': () => false });
        console.log('Could not complete seat selection + booking after all coach search rounds.');
    }

    check(null, { '4. Create Cart 201': () => booked || lastSeatOk });

    sleep(1);
}
