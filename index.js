const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const cron = require('node-cron');
const app = express();
app.use(express.json());

const LINE_TOKEN = process.env.LINE_TOKEN;
const SHEET_ID   = process.env.SHEET_ID;
const FACTORY    = process.env.FACTORY_NAME || "โรงงาน";

const COL = {
  NAME: 2, TYPE: 3, UNIT: 4, STOCK: 5,
  REORDER: 6, ORDER_QTY: 7,
  SUPPLIER_A: 8, SUPPLIER_B: 9,
  ROTATE: 10, LAST_QUEUE: 11,
  STATUS: 12  // คอลัมน์ L — สถานะ
};

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
    }, { headers: { 'Authorization': `Bearer ${LINE_TOKEN}` } });
    return res.status;
  } catch(e) {
    console.error('sendLine error:', e.response?.data || e.message);
    return 0;
  }
}

async function getFactoryGroupId(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'ตั้งค่า_Line_Bot!B3',
  });
  return (res.data.values || [['']])[0][0];
}

async function updateRow(sheets, rowIndex, queue, status) {
  // อัพเดท Last Queue (K) และ Status (L) พร้อมกัน
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Stock_วัตถุดิบ!K${rowIndex}:L${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[queue, status]] }
  });
}

async function logHistory(sheets, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'ประวัติ_สั่งซื้อ!A:G',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

async function checkAllStock() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Stock_วัตถุดิบ!A5:L100',
  });

  const rows = res.data.values || [];
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  let ordered = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i];
    const name     = row[COL.NAME - 1] || '';
    const unit     = row[COL.UNIT - 1] || '';
    const stock    = parseFloat(row[COL.STOCK - 1]) || 0;
    const reorder  = parseFloat(row[COL.REORDER - 1]) || 0;
    const orderQty = parseFloat(row[COL.ORDER_QTY - 1]) || 0;
    const supA     = row[COL.SUPPLIER_A - 1] || '';
    const supB     = row[COL.SUPPLIER_B - 1] || '';
    const rotate   = (row[COL.ROTATE - 1] || 'NO').toUpperCase() === 'YES';
    const lastQ    = (row[COL.LAST_QUEUE - 1] || 'B').toUpperCase();
    const status   = (row[COL.STATUS - 1] || '').toString();

    if (!name) continue;

    const actualRow = i + 5;

    // ถ้า Stock กลับมาสูงกว่า Reorder Point → รีเซ็ตสถานะ
    if (stock > reorder && status === '⏳ รอของ') {
      await updateRow(sheets, actualRow, lastQ, '✅ ปกติ');
      continue;
    }

    // ข้ามถ้า Stock ปกติ หรือกำลังรอของอยู่แล้ว
    if (stock > reorder) continue;
    if (status === '⏳ รอของ') {
      skipped++;
      continue;
    }

    // เลือกซัพพลายเออร์
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
      // อัพเดทสถานะเป็น "รอของ" อัตโนมัติ
      await updateRow(sheets, actualRow, targetQueue, '⏳ รอของ');

      const factoryGroupId = await getFactoryGroupId(sheets);
      if (factoryGroupId) {
        await sendLine(factoryGroupId,
          `🤖 Bot สั่งซื้อแล้ว\n▪️ ${name} : ${orderQty} ${unit}\n▪️ จาก : ${supName} (คิว ${targetQueue})\n⏳ รอรับของ\n🕐 ${now}`
        );
      }
      await logHistory(sheets, [now, name, orderQty, unit, supName, targetQueue, '✅ ส่งแล้ว']);
      ordered++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ordered, skipped };
}

// Routes
app.get('/', (req, res) => res.json({ status: 'Stock Bot running ✅' }));

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
    const result = await checkAllStock();
    res.json({ status: 'ok', ...result });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stock Bot running on port ${PORT}`));

// ตรวจ Stock อัตโนมัติทุกเช้า 8 โมง (เวลาไทย)
cron.schedule('0 1 * * *', async () => {
  console.log('Auto check stock...');
  try {
    const result = await checkAllStock();
    console.log('Auto check done:', result);
  } catch(e) {
    console.error('Auto check error:', e.message);
  }
}, { timezone: 'Asia/Bangkok' });
