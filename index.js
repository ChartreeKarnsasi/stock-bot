const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_TOKEN;
const SHEET_ID   = process.env.SHEET_ID;
const FACTORY    = process.env.FACTORY_NAME || "โรงงาน";

// Google Sheets Auth — รองรับทั้ง JSON string และ base64
async function getSheets() {
  let creds;
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error("GOOGLE_CREDENTIALS is not set");
  try {
    creds = JSON.parse(raw);
  } catch(e) {
    try {
      creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch(e2) {
      throw new Error("GOOGLE_CREDENTIALS is invalid: " + e2.message);
    }
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function sendLine(groupId, message) {
  try {
    const res = await axios.post('https://api.line.me/v2/bot/message/push', {
      to: groupId,
      messages: [{ type: 'text', text: message }]
    }, {
      headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
    return res.status;
  } catch(e) {
    console.error('sendLine error:', e.response?.data || e.message);
    return 0;
  }
}

async function logHistory(sheets, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'ประวัติ_สั่งซื้อ!A:G',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

async function updateQueue(sheets, rowIndex, queue) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Stock_วัตถุดิบ!K${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[queue]] }
  });
}

async function getFactoryGroupId(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'ตั้งค่า_Line_Bot!B3',
  });
  return (res.data.values || [['']])[0][0];
}

async function checkAllStock() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Stock_วัตถุดิบ!A5:K100',
  });

  const rows = res.data.values || [];
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  let ordered = 0;

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i];
    const name     = row[1] || '';
    const unit     = row[3] || '';
    const stock    = parseFloat(row[4]) || 0;
    const reorder  = parseFloat(row[5]) || 0;
    const orderQty = parseFloat(row[6]) || 0;
    const supA     = row[7] || '';
    const supB     = row[8] || '';
    const rotate   = (row[9] || 'NO').toUpperCase() === 'YES';
    const lastQ    = (row[10] || 'B').toUpperCase();

    if (!name || stock > reorder) continue;

    let targetQueue = 'A';
    let targetSup   = supA;
    if (rotate && supB) {
      targetQueue = lastQ === 'A' ? 'B' : 'A';
      targetSup   = targetQueue === 'A' ? supA : supB;
    }

    if (!targetSup) continue;
    const parts      = targetSup.split('|');
    const supName    = parts[0].trim();
    const supGroupId = parts[1] ? parts[1].trim() : '';
    if (!supGroupId) continue;

    const isUrgent = stock <= 0;
    const orderMsg =
      `📋 ใบสั่งซื้อวัตถุดิบ\n` +
      `🏭 ${FACTORY}\n` +
      `🕐 ${now}\n` +
      `${'─'.repeat(28)}\n\n` +
      `${isUrgent ? '🔴 ด่วนมาก! Stock หมดแล้ว' : '🟡 Stock ใกล้หมด'}\n\n` +
      `▪️ วัตถุดิบ : ${name}\n` +
      `▪️ ปริมาณ  : ${orderQty} ${unit}\n` +
      `▪️ Stock เหลือ : ${stock} ${unit}\n\n` +
      `${'─'.repeat(28)}\n` +
      `กรุณายืนยันและแจ้งวันจัดส่งด้วยครับ/ค่ะ 🙏`;

    const code = await sendLine(supGroupId, orderMsg);
    if (code === 200) {
      await updateQueue(sheets, i + 5, targetQueue);
      const factoryGroupId = await getFactoryGroupId(sheets);
      if (factoryGroupId) {
        await sendLine(factoryGroupId,
          `🤖 Bot สั่งซื้อแล้ว\n▪️ ${name} : ${orderQty} ${unit}\n▪️ จาก : ${supName} (คิว ${targetQueue})\n🕐 ${now}`
        );
      }
      await logHistory(sheets, [now, name, orderQty, unit, supName, targetQueue, '✅ ส่งแล้ว']);
      ordered++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return ordered;
}

// Routes
app.get('/', (req, res) => res.json({ status: 'Stock Bot running ✅' }));

// Debug — เช็ค env variables
app.get('/debug', (req, res) => {
  res.json({
    LINE_TOKEN: LINE_TOKEN ? `✅ (${LINE_TOKEN.length} chars)` : '❌ missing',
    SHEET_ID: SHEET_ID ? `✅ ${SHEET_ID}` : '❌ missing',
    GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS ? `✅ (${process.env.GOOGLE_CREDENTIALS.length} chars)` : '❌ missing',
    FACTORY_NAME: FACTORY,
  });
});

app.post('/webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });
  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.source && event.source.type === 'group') {
        const groupId = event.source.groupId;
        const text    = event.message?.text || '';
        if (text.toLowerCase().includes('group id')) {
          await sendLine(groupId,
            `📋 Group ID ของกลุ่มนี้:\n${groupId}\n\nคัดลอกไปวางใน Sheet ได้เลยครับ`
          );
        }
      }
    }
  } catch(e) {
    console.error(e);
  }
});

app.get('/check', async (req, res) => {
  try {
    const ordered = await checkAllStock();
    res.json({ status: 'ok', ordered });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stock Bot running on port ${PORT}`));
