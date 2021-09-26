const fs = require('fs');
const {promisify} = require('util');
const readline = require('readline');
const process = require('process');

const deepcompare = require('deep-compare');
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
const scheduleSheetId = '1WYsPnHke3RSYaQ7IdzacMFoTKfK-eJb9xXazXHRT76I';
const userSheetPageName = 'Formularantworten 1';
const sheetPageName = 'VolunteerInput';
const offsetLeft = 3;
const offsetTop = 3;

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
}

function getCellCode(col, row) {
	return `${getColLetters(col)}${row + 1}`;
}

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

async function getUsers(sheets) {
	const authSheet = (await sheets.spreadsheets.values.get({
		spreadsheetId: userSheetId,
		range: `Formularantworten 1!$A1:$CZ500`,
	})).data.values;
	const labels = authSheet.shift();
	const knownCreds = Object.fromEntries(authSheet.map((row, i) => [row[labels.indexOf('Key')], {
		rowIndex: i + 1,
		key: row[labels.indexOf('Key')],
		id: row[labels.indexOf('Reg ID')],
		firstName: row[labels.indexOf('First name')],
		lastName: row[labels.indexOf('Last name')],
		name: `${row[labels.indexOf('First name')]} ${row[labels.indexOf('Last name')]}`,
		isCaptain: !!row[labels.indexOf('Teamcaptain')],
		isCanceled: !!row[labels.indexOf('Canceled')],
	}]));
	return knownCreds;
}

async function checkAuth(req, res, next) {
	const [key] = ((req.get('Authorization') || '').split(' ')[1] || '').split(':');
	if (!(key)) {
		return res.status(401).send('need auth');
	}
	const auth = await getAuth();
	const sheets = google.sheets({ version: 'v4', auth });
	const knownCreds = await getUsers(sheets);

	if (!knownCreds[key]) {
		return res.status(401).send('unknown key');
	}
	req.knownCreds = knownCreds;
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

app.get('/shiftsSheetInfo', (req, res) => {
	res.send({id: scheduleSheetId, offsetLeft, offsetTop, name: sheetPageName});
});

app.get('/users/me', checkAuth, async (req, res) => {
	res.send({
		teamId: req.creds.id.split('-')[0],
		username: req.creds.id,
		firstName: req.creds.firstName,
		lastName: req.creds.lastName,
		isCaptain: req.creds.isCaptain
	});
});

app.get('/teams/:teamId', checkAuth, async (req, res) => {
	if (!req.creds.isCaptain) {
		return res.status(401).send();
	}
	const members = Object.values(req.knownCreds).filter(member => member.id.startsWith(`${req.params.teamId}-`));
	log.d('members', members);
	res.send({members: members.map(m => ({id: m.id, firstName: m.firstName, lastName: m.lastName, name: m.name}))});
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

const selectableColors = [
	{red: 1, green: 0.5019608}, //orange
	{red: 1, green: 1 }, //yellow
	{red: 1 }, //red
	{green: 1 }, //green
];

app.post('/shifts/:shiftId/claims', checkAuth, async (req, res) => {
	const {shiftId} = req.params;
	validateShiftId(shiftId, res);
	const username = req.creds.id;
	const sheets = google.sheets({version: 'v4', auth: await getAuth()});
	try {
		const scheduleColData = (await sheets.spreadsheets.get({
			spreadsheetId: scheduleSheetId,
			includeGridData: true,
			ranges: `${sheetPageName}!${shiftId}`,
		}));
		// log.d('scheduleColData', scheduleColData.data.sheets[0]);
		const cellData = scheduleColData.data.sheets[0].data[0].rowData[0].values[0];
		// log.d('scheduleColData.backgroundColor', cellData.effectiveFormat.backgroundColor);
		if (cellData.effectiveValue) {
			return res.status(400).send('Shift already claimed');
		}
		if (!selectableColors.find(c => deepcompare(c, cellData.effectiveFormat.backgroundColor))) {
			return res.status(400).send('Not a shift');
		}
	} catch (e) {
		log.d('error retrieving cell info', e);
		return res.status(400).send('unable to check shift; probably invalid ID');
	}
	// The shift is free ; claim it
	const appendResult = await sheets.spreadsheets.values.update({
		spreadsheetId: scheduleSheetId,
		range: `${sheetPageName}!${shiftId}:${shiftId}`,
		valueInputOption: "USER_ENTERED",
		resource: {
			values: [[username]],
		},
	});
	checkGoogleResult(appendResult, 'changing value');
	log.i(`user ${username} claimed ${shiftId}`);
	updateNumberOfShifts(req, sheets, username);
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
			range: `${sheetPageName}!${shiftId}`,
		})).data.values;
		if (scheduleColData[0][0] !== username) {
			return res.status(400).send('Shift not yours');
		}
	} catch (e) {
		log.w('unable to check shift', e);
		return res.status(400).send('unable to check shift; probably invalid ID');
	}
	// The shift is ours ; free it
	const appendResult = await sheets.spreadsheets.values.update({
		spreadsheetId: scheduleSheetId,
		range: `${sheetPageName}!${shiftId}:${shiftId}`,
		valueInputOption: "USER_ENTERED",
		resource: {
			values: [['']],
		},
	});
	checkGoogleResult(appendResult, 'changing value');
	log.i(`user ${username} unclaimed ${shiftId}`);
	updateNumberOfShifts(req, sheets, username);
	res.send();
});

async function updateNumberOfShifts(req, sheets, username) {
	try {
		const scheduleData = (await sheets.spreadsheets.values.get({
			spreadsheetId: scheduleSheetId,
			range: `${sheetPageName}!$a1:zz99`,
		})).data.values;
		const shiftsOwned = [];
		scheduleData.forEach((row, rowIdx) => {
			row.forEach((col, colIdx) => {
				if (col === username) {
					shiftsOwned.push(getCellCode(colIdx, rowIdx));
				}
			});
		});
		const shiftsCount = shiftsOwned.length;

		const shiftsCell = getCellCode((await getLabels()).indexOf('Shifts'), req.creds.rowIndex);
		log.d(`user ${username} shiftsCount ${shiftsCount} shiftsCell ${shiftsCell}`);
		const appendResult = await sheets.spreadsheets.values.update({
			spreadsheetId: userSheetId,
			range: `${userSheetPageName}!${shiftsCell}:${shiftsCell}`,
			valueInputOption: "USER_ENTERED",
			resource: {
				values: [[shiftsCount]],
			},
		});

	} catch (e) {
		log.w('unable to get shifts count', e);
		return;
	}

}

app.listen(port, () => {
	console.log(`Shift selector API running at http://localhost:${port}`);
});

async function updateAllCounts() {
	const sheets = google.sheets({version: 'v4', auth: await getAuth()});
	const labels = await getLabels();
	const idCol = getColLetters(labels.indexOf('Reg ID'));
	log.d('idCol', idCol);
	const ids = await getValuesForCol(idCol);
	for (let index = 0; index < ids.length ; ++index) {
		const id = ids[index];
		await (new Promise(r => setTimeout(r, 1000)));
		updateNumberOfShifts({creds: {rowIndex: index + 1}}, sheets, id);
	}
}

getAuth();
// updateAllCounts();
