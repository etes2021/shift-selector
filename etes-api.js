const fs = require('fs');
const {promisify} = require('util');
const readline = require('readline');
const process = require('process');

const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const request = require('request-promise-native');

const log = require('./log');
const {getAuth} = require('./google-auth');

const app = express();
const port = process.env.PORT || 3000;
const userSheetId = '1DT2QYRYiGPS0MewiEcMTjtGRcwKOzUCafLaCO7jITlo';
const scheduleSheetId = '1ndNpWrRW30yL_ZjlzhKEsTNCuOR5AdnTFulOQ_JfJCw';

app.use(cors());
app.use(bodyParser.json());

let knownCreds = {};
let knownNames = {};

function getColLetters(column) {
	const a1Notation = [];
	const totalAlphabets = "Z".charCodeAt() - "A".charCodeAt() + 1;
	let block = column;
	while (block >= 0) {
		a1Notation.unshift(
			String.fromCharCode((block % totalAlphabets) + "A".charCodeAt())
		);
		block = Math.floor(block / totalAlphabets) - 1;
	}
	return a1Notation.join("");
};

let labels;
async function getLabels() {
	if (!labels) {
		const auth = await getAuth();
		const sheets = google.sheets({ version: 'v4', auth });
		labels = (await sheets.spreadsheets.values.get({
			spreadsheetId: userSheetId,
			range: 'Formularantworten 1!A1:AZ1',
		})).data.values[0];
	}
	return labels;
}

async function updateCreds() {
	const auth = await getAuth();
	const sheets = google.sheets({ version: 'v4', auth });
	const labels = await getLabels();
	// log.d('labels', labels);
	const firstNameCol = getColLetters(labels.indexOf('First name'));
	const idCol = getColLetters(labels.indexOf('Reg ID'));
	const pwdCol = getColLetters(labels.indexOf('PWD'));
	const nameCol = getColLetters(labels.indexOf('First name'));
	const credsData = (await sheets.spreadsheets.values.get({
		spreadsheetId: userSheetId,
		range: `Formularantworten 1!${idCol}2:${pwdCol}500`,
	})).data.values.map(tuple => ([tuple[0], tuple[tuple.length - 1]]));
	knownCreds = Object.fromEntries(credsData);
	const namesData = (await sheets.spreadsheets.values.get({
		spreadsheetId: userSheetId,
		range: `Formularantworten 1!${idCol}2:${nameCol}500`,
	})).data.values.map(tuple => ([tuple[tuple.length - 1], tuple[0]]));
	knownNames = Object.fromEntries(namesData);
}

async function checkAuthCached(req, res, next) {
	const [username, password] = ((req.get('Authorization') || '').split(' ')[1] || '').split(':');
	if (!(username && password)) {
		return res.status(401).send('need auth');
	}
	if (!knownCreds[username]) {
		await updateCreds();
	}
	if (!knownCreds[username]) {
		return res.status(401).send('unknown user');
	}
	if (knownCreds[username] !== password) {
		return res.status(401).send('unauthorized');
	}
	req.username = username;
	next();
}

async function getValuesForCol(col) {
	const auth = await getAuth();
	const sheets = google.sheets({ version: 'v4', auth });
	return (await sheets.spreadsheets.values.get({
		spreadsheetId: userSheetId,
		range: `Formularantworten 1!${col}2:${col}500`,
	})).data.values.map(r => r[0]);
}

async function checkAuth(req, res, next) {
	const [key] = ((req.get('Authorization') || '').split(' ')[1] || '').split(':');
	if (!(key)) {
		return res.status(401).send('need auth');
	}
	const auth = await getAuth();
	const sheets = google.sheets({ version: 'v4', auth });
	const labels = await getLabels();
	const idCol = getColLetters(labels.indexOf('Reg ID'));
	const keyCol = getColLetters(labels.indexOf('Key'));
	const nameCol = getColLetters(labels.indexOf('First name'));
	const [keys, ids, names] = await Promise.all([
		getValuesForCol(keyCol),
		getValuesForCol(idCol),
		getValuesForCol(nameCol),
	]);
	const knownCreds = Object.fromEntries(keys.map((key, i) => [key, {key, id: ids[i], name: names[i]}]));
	if (!knownCreds[key]) {
		return res.status(401).send('unknown key');
	}
	req.creds = knownCreds[key];
	next();
}

function validateShiftId(shiftId, res) {
	if (!shiftId) {
		return res.status(400).send('need shift ID');
	}
	if (!shiftId.match(/^[aA-zA]{1,2}[0-9]{1,2}$/)) {
		return res.status(400).send('invalid shift ID');
	}
}

function checkGoogleResult(result, action) {
	if (result.status !== 200) {
		return res.status(500).send(`problem ${action}`);
		throw new Error(`problem ${action}: ${appendResult.statusText}`);
	}
}

app.get('/shiftsSheetId', (req, res) => {
	res.send(scheduleSheetId);
});

app.get('/users/me', checkAuth, async (req, res) => {
	res.send({username: req.creds.id, firstName: req.creds.name});
});

app.post('/sessions', async (req, res) => {
	const auth = await getAuth();
	const sheets = google.sheets({ version: 'v4', auth });
	const labels = await getLabels();
	const idCol = getColLetters(labels.indexOf('Reg ID'));
	const keyCol = getColLetters(labels.indexOf('Key'));
	const pwdCol = getColLetters(labels.indexOf('PWD'));
	const [keys, ids, pwds] = await Promise.all([
		getValuesForCol(keyCol),
		getValuesForCol(idCol),
		getValuesForCol(pwdCol),
	]);
	const idx = ids.indexOf(req.body.username);
	if (idx === -1) {
		log.d('unknown user ' + req.body.username);
		return res.status(401).send();
	}
	if (pwds[idx] !== req.body.password) {
		log.d('wrong password');
		return res.status(401).send();
	}
	res.send({token: keys[idx]});
});

app.post('/shifts/:shiftId/claims', checkAuth, async (req, res) => {
	const {shiftId} = req.params;
	validateShiftId(shiftId, res);
	const username = req.creds.id;
	const sheets = google.sheets({version: 'v4', auth: await getAuth()});
	try {
		const scheduleColData = (await sheets.spreadsheets.values.get({
			spreadsheetId: scheduleSheetId,
			range: `schedule!${shiftId}`,
		})).data.values;
		log.d('scheduleColData', scheduleColData);
		if (scheduleColData) {
			return res.status(400).send('Shift already claimed');
		}
	} catch (e) {
		return res.status(400).send('unable to check shift; probably invalid ID');
	}
	// The shift is free ; claim it
	const appendResult = await sheets.spreadsheets.values.update({
		spreadsheetId: scheduleSheetId,
		range: `schedule!${shiftId}:${shiftId}`,
		valueInputOption: "USER_ENTERED",
		resource: {
			values: [[username]],
		},
	});
	checkGoogleResult(appendResult, 'changing value');
	res.send();
});

app.delete('/shifts/:shiftId/claims', checkAuth, async (req, res) => {
	const {shiftId} = req.params;
	validateShiftId(shiftId, res);
	const username = req.creds.id;
	const sheets = google.sheets({version: 'v4', auth: await getAuth()});
	try {
		const scheduleColData = (await sheets.spreadsheets.values.get({
			spreadsheetId: scheduleSheetId,
			range: `schedule!${shiftId}`,
		})).data.values;
		if (scheduleColData[0][0] !== username) {
			return res.status(400).send('Shift not yours');
		}
	} catch (e) {
		return res.status(400).send('unable to check shift; probably invalid ID');
	}
	// The shift is ours ; free it
	const appendResult = await sheets.spreadsheets.values.update({
		spreadsheetId: scheduleSheetId,
		range: `schedule!${shiftId}:${shiftId}`,
		valueInputOption: "USER_ENTERED",
		resource: {
			values: [['']],
		},
	});
	checkGoogleResult(appendResult, 'changing value');
	res.send();
});

app.listen(port, () => {
	console.log(`Shift selector API running at http://localhost:${port}`);
});
