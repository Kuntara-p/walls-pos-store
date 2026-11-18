// ========================================================
// Ice Cream Batch Tracker - Application Logic
// Tech Stack: Vanilla JS + Supabase JS SDK / LocalStorage Fallback
// ========================================================

const STORAGE_KEYS = {
  SUPABASE_URL: 'batch_tracker_sb_url',
  SUPABASE_KEY: 'batch_tracker_sb_key',
  STORAGE_MODE: 'batch_tracker_mode',
  LOCAL_LOTS: 'batch_tracker_local_lots',
  LOCAL_SALES: 'batch_tracker_local_sales',
  LOCAL_PRODUCTS: 'batch_tracker_local_products',
  LOCAL_ORDER_DRAFT: 'batch_tracker_order_draft',
  LOCAL_PO_META: 'batch_tracker_po_meta',
  LOCAL_WITHDRAWALS: 'batch_tracker_local_withdrawals',
  LOCAL_LOT_NOTES: 'batch_tracker_lot_notes',
  LOCAL_LOT_ORDERS: 'batch_tracker_lot_orders',
  PENDING_SALES_QUEUE: 'batch_tracker_pending_sales',
  CLEARED_TEST_WITHDRAWAL_V21: 'batch_tracker_cleared_test_w_v21',
  LOCAL_DIRECTOR_VISITS: 'batch_tracker_director_visits',
};

// Standard 2-decimal currency rounding & safe cost parser
function roundMoney(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseLotCost(costVal, fallback = 5000) {
  if (costVal === null || costVal === undefined || costVal === '') return fallback;
  const n = parseFloat(costVal);
  return (!isNaN(n) && n >= 0) ? roundMoney(n) : fallback;
}

function getLocalDateISO(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cleanUpLegacyTestWithdrawalsOnce() {
  try {
    if (localStorage.getItem(STORAGE_KEYS.CLEARED_TEST_WITHDRAWAL_V21)) return;
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_WITHDRAWALS);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const filtered = list.filter(w => {
          const p = String(w.purpose || '');
          const amt = parseFloat(w.amount) || 0;
          if (amt === 200 && p.includes('ซื้อเสื้อกีฬา')) return false;
          return true;
        });
        localStorage.setItem(STORAGE_KEYS.LOCAL_WITHDRAWALS, JSON.stringify(filtered));
      }
    }
    localStorage.setItem(STORAGE_KEYS.CLEARED_TEST_WITHDRAWAL_V21, '1');
  } catch (e) {}
}

// Project Default Supabase Cloud Configuration (Auto-configured)
const DEFAULT_SUPABASE = {
  URL: 'https://xsrxmjwezrbwpinhaenz.supabase.co',
  KEY: 'sb_publishable_93zfEdNFZFQsoz_kD-ulag_NtEi_u2_'
};

// Application State
let supabaseClient = null;
let isOfflineMode = false;
let activeLot = null;
let currentLotSales = [];
let closedLots = [];
let currentInputAmount = '';
let selectedShift = 'lunch'; // 'lunch' | 'afternoon'
let currentReportScope = 'active'; // 'active' | 'all' | lotId
let productCatalog = [];
let orderDraftQuantities = {}; // { [productId]: boxQuantity }
let currentProductCategory = 'all';

// ========================================================
// 1. App Initialization & Supabase Client Setup
// ========================================================
document.addEventListener('DOMContentLoaded', async () => {
  cleanUpLegacyTestWithdrawalsOnce();
  initNumpadKeyboardSupport();
  await setupDatabaseClient();
  await loadActiveLotData();
  await loadProductCatalog();
  applyDirectorViewMode();
  initAutoRefreshSystem();

  window.addEventListener('online', () => {
    tryReconnectAndFlushPending();
  });
});

function setOnlineBadgeUI() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const statusBadge = document.getElementById('db-status-badge');
  const statusDot = document.getElementById('db-status-dot');
  const statusText = document.getElementById('db-status-text');
  if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0';
  if (statusText) statusText.innerText = 'ออนไลน์';
  if (statusBadge) statusBadge.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/15 hover:bg-white/25 text-white border border-white/25 whitespace-nowrap shrink-0 cursor-pointer shadow-sm';
}

function setOfflineBadgeUI(isTemporary = false) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const statusBadge = document.getElementById('db-status-badge');
  const statusDot = document.getElementById('db-status-dot');
  const statusText = document.getElementById('db-status-text');
  if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-300 shrink-0';
  if (statusText) statusText.innerText = isTemporary ? 'ออฟไลน์ชั่วคราว' : 'ในเครื่อง';
  if (statusBadge) statusBadge.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-500/25 text-amber-100 border border-amber-300/40 whitespace-nowrap shrink-0 cursor-pointer shadow-sm';
}

async function setupDatabaseClient() {
  const preferredMode = localStorage.getItem(STORAGE_KEYS.STORAGE_MODE);
  
  // If user explicitly chose local mode in settings, remain offline
  if (preferredMode === 'local') {
    enableLocalMode(false);
    return;
  }

  const sbUrl = localStorage.getItem(STORAGE_KEYS.SUPABASE_URL) || DEFAULT_SUPABASE.URL;
  const sbKey = localStorage.getItem(STORAGE_KEYS.SUPABASE_KEY) || DEFAULT_SUPABASE.KEY;

  if (sbUrl && sbKey && window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(sbUrl, sbKey);
      // Quick ping test
      const { data, error } = await supabaseClient.from('lots').select('id').limit(1);
      if (error) throw error;

      isOfflineMode = false;
      setOnlineBadgeUI();
      await flushPendingSalesQueue();
      await syncLocalMetadataToCloud();
      return;
    } catch (err) {
      console.warn('Supabase connect failed, falling back to temporary local mode:', err);
    }
  }

  enableLocalMode(true);
}

function enableLocalMode(isTemporary = false) {
  isOfflineMode = true;
  if (!isTemporary) {
    supabaseClient = null;
  }
  setOfflineBadgeUI(isTemporary);
  ensureLocalInitialData();
}

async function tryReconnectAndFlushPending() {
  const preferredMode = localStorage.getItem(STORAGE_KEYS.STORAGE_MODE);
  if (preferredMode === 'local') return false;

  const sbUrl = localStorage.getItem(STORAGE_KEYS.SUPABASE_URL) || DEFAULT_SUPABASE.URL;
  const sbKey = localStorage.getItem(STORAGE_KEYS.SUPABASE_KEY) || DEFAULT_SUPABASE.KEY;
  if (!sbUrl || !sbKey || !window.supabase) return false;

  try {
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(sbUrl, sbKey);
    }
    const { error } = await supabaseClient.from('lots').select('id').limit(1);
    if (error) throw error;

    const wasOffline = isOfflineMode;
    isOfflineMode = false;
    setOnlineBadgeUI();
    await flushPendingSalesQueue();
    await syncLocalMetadataToCloud();
    if (wasOffline) {
      showToast('กลับมาเชื่อมต่อฐานข้อมูลออนไลน์เรียบร้อยแล้ว', 'success');
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function flushPendingSalesQueue() {
  if (isOfflineMode || !supabaseClient || (typeof isDirectorViewMode === 'function' && isDirectorViewMode())) return;
  try {
    const queue = JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_SALES_QUEUE) || '[]');
    if (!Array.isArray(queue) || queue.length === 0) return;

    const remaining = [];
    const affectedLotIds = new Set();

    for (const item of queue) {
      try {
        let { error } = await supabaseClient
          .from('daily_sales')
          .upsert([{
            id: item.id,
            lot_id: item.lot_id,
            amount: roundMoney(item.amount),
            shift: item.shift || 'lunch',
            note: item.note || '',
            float_deducted: roundMoney(item.float_deducted || 0),
            created_at: item.created_at
          }]);
        if (error) {
          const { error: err2 } = await supabaseClient
            .from('daily_sales')
            .upsert([{ id: item.id, lot_id: item.lot_id, amount: roundMoney(item.amount), created_at: item.created_at }]);
          if (err2) throw err2;
        }
        affectedLotIds.add(item.lot_id);
      } catch (err) {
        remaining.push(item);
      }
    }

    localStorage.setItem(STORAGE_KEYS.PENDING_SALES_QUEUE, JSON.stringify(remaining));

    for (const lotId of affectedLotIds) {
      await recalculateAndSyncLotTotalDB(lotId);
    }

    if (affectedLotIds.size > 0) {
      showToast(`ซิงค์ข้อมูลยอดขายที่ค้างตอนออฟไลน์ขึ้นคลาวด์สำเร็จ!`, 'success');
    }
  } catch (e) {
    console.warn('Flush pending sales queue warning:', e);
  }
}

async function syncLocalMetadataToCloud() {
  if (isOfflineMode || !supabaseClient || (typeof isDirectorViewMode === 'function' && isDirectorViewMode())) return;
  try {
    // Sync local lot_orders and lot_notes to public.lots if columns exist
    const localOrders = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_ORDERS) || '{}');
    const localNotes = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_NOTES) || '{}');
    const lotIds = new Set([...Object.keys(localOrders), ...Object.keys(localNotes)]);

    for (const lotId of lotIds) {
      const updatePayload = {};
      if (localOrders[lotId]) updatePayload.order_data = localOrders[lotId];
      if (localNotes[lotId] !== undefined) updatePayload.lot_note = localNotes[lotId];
      if (Object.keys(updatePayload).length > 0) {
        const { error } = await supabaseClient.from('lots').update(updatePayload).eq('id', lotId);
        if (error) break; // Column likely not migrated yet; stop silently
      }
    }
  } catch (e) {}
}

function syncLotMetadataFromCloudRow(lot) {
  if (!lot || !lot.id) return;
  try {
    if (lot.order_data && typeof lot.order_data === 'object') {
      const allOrders = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_ORDERS) || '{}');
      allOrders[lot.id] = lot.order_data;
      localStorage.setItem(STORAGE_KEYS.LOCAL_LOT_ORDERS, JSON.stringify(allOrders));
    }
    if (typeof lot.lot_note === 'string' && lot.lot_note.trim() !== '') {
      const allNotes = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_NOTES) || '{}');
      if (!allNotes[lot.id]) {
        allNotes[lot.id] = lot.lot_note.trim();
        localStorage.setItem(STORAGE_KEYS.LOCAL_LOT_NOTES, JSON.stringify(allNotes));
      }
    }
  } catch (e) {}
}

function ensureLocalInitialData() {
  let localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  if (localLots.length === 0) {
    const initialLot = {
      id: generateUUID(),
      cost: 5000,
      float_money: 500,
      total_collected: 0,
      status: 'active',
      created_at: new Date().toISOString(),
      closed_at: null
    };
    localLots = [initialLot];
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
}

// ========================================================
// 2. Data Operations (Supabase / LocalStorage Abstraction)
// ========================================================
async function fetchActiveLot() {
  const isReadOnly = typeof isDirectorViewMode === 'function' && isDirectorViewMode();

  if (isOfflineMode && localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) !== 'local') {
    await tryReconnectAndFlushPending();
  }

  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('lots')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;

      if (data && data.length > 0) {
        const lot = data[0];
        lot.cost = parseLotCost(lot.cost, 5000);
        lot.total_collected = roundMoney(lot.total_collected || 0);
        syncLotMetadataFromCloudRow(lot);
        return lot;
      } else if (!isReadOnly) {
        // Auto-create initial active lot ONLY in admin mode if none exists
        const newLot = {
          cost: 5000,
          float_money: 500,
          total_collected: 0,
          status: 'active'
        };
        const { data: created, error: createErr } = await supabaseClient
          .from('lots')
          .insert([newLot])
          .select()
          .single();
        if (createErr) throw createErr;
        return created;
      } else {
        return null;
      }
    } catch (e) {
      console.error('Error fetching active lot from Supabase:', e);
      showToast('การเชื่อมต่อสะดุด สลับใช้ข้อมูลสำรองในเครื่องชั่วคราว', 'warning');
      enableLocalMode(true);
    }
  }

  // LocalStorage Fallback
  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  let active = localLots.find(l => l.status === 'active');
  if (!active && !isReadOnly) {
    active = {
      id: generateUUID(),
      cost: 5000,
      float_money: 500,
      total_collected: 0,
      status: 'active',
      created_at: new Date().toISOString(),
      closed_at: null
    };
    localLots.unshift(active);
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  if (active && active.float_money === undefined) active.float_money = 500;
  return active || null;
}

async function fetchSalesForLot(lotId) {
  if (!lotId) return [];

  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('daily_sales')
        .select('*')
        .eq('lot_id', lotId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (e) {
      console.error('Error fetching sales from Supabase:', e);
    }
  }

  // LocalStorage Fallback
  const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  return allSales
    .filter(s => s.lot_id === lotId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function recalculateAndSyncLotTotalDB(lotId) {
  if (!lotId) return 0;
  const sales = await fetchSalesForLot(lotId);
  const recalculatedTotal = roundMoney(sales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0));

  if (!isOfflineMode && supabaseClient) {
    try {
      await supabaseClient.from('lots').update({ total_collected: recalculatedTotal }).eq('id', lotId);
    } catch (e) {
      console.warn('Could not update recalculated total_collected in Supabase:', e);
    }
  }

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lotIdx = localLots.findIndex(l => l.id === lotId);
  if (lotIdx !== -1) {
    localLots[lotIdx].total_collected = recalculatedTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  if (activeLot && activeLot.id === lotId) {
    activeLot.total_collected = recalculatedTotal;
  }
  return recalculatedTotal;
}

async function insertDailySale(lotId, amount, shift = 'lunch', note = '', floatDeducted = 0) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) {
    showToast('โหมดผู้บริหารไม่สามารถบันทึกข้อมูลได้', 'error');
    return { ok: false, mode: 'readonly' };
  }

  const cleanAmount = roundMoney(amount);
  const cleanFloatDeducted = roundMoney(floatDeducted);
  const newSale = {
    id: generateUUID(),
    lot_id: lotId,
    amount: cleanAmount,
    shift: shift || 'lunch',
    note: note || '',
    float_deducted: cleanFloatDeducted,
    created_at: new Date().toISOString()
  };

  if (isOfflineMode && localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) !== 'local') {
    await tryReconnectAndFlushPending();
  }

  let insertedToCloud = false;

  if (!isOfflineMode && supabaseClient) {
    try {
      // 1. Insert daily sale (with graceful fallback if extended columns aren't migrated yet)
      let { error: saleErr } = await supabaseClient
        .from('daily_sales')
        .insert([{
          id: newSale.id,
          lot_id: lotId,
          amount: cleanAmount,
          shift: shift || 'lunch',
          note: note || '',
          float_deducted: cleanFloatDeducted,
          created_at: newSale.created_at
        }]);

      if (saleErr) {
        const { error: fallbackErr } = await supabaseClient
          .from('daily_sales')
          .insert([{ id: newSale.id, lot_id: lotId, amount: cleanAmount }]);
        if (fallbackErr) throw fallbackErr;
      }

      insertedToCloud = true;

      // 2. Recalculate active lot total_collected from actual daily_sales rows (prevents multi-device race condition)
      try {
        await recalculateAndSyncLotTotalDB(lotId);
      } catch (lotUpdateErr) {
        console.warn('Lot total update failed after sale insert, will self-heal on next sync:', lotUpdateErr);
      }

      // Mirror in local cache without duplicating
      const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
      if (!allSales.some(s => s.id === newSale.id)) {
        allSales.unshift(newSale);
        localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));
      }

      return { ok: true, mode: 'cloud' };
    } catch (err) {
      console.error('Supabase write error:', err);
      if (!insertedToCloud) {
        enableLocalMode(true);
      }
    }
  }

  // LocalStorage Fallback (only executed if cloud insert did NOT happen)
  const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  allSales.unshift(newSale);
  localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));

  const lotSales = allSales.filter(s => s.lot_id === lotId);
  const newTotal = roundMoney(lotSales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0));

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lotIdx = localLots.findIndex(l => l.id === lotId);
  if (lotIdx !== -1) {
    localLots[lotIdx].total_collected = newTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }

  // Queue for automatic cloud sync when internet returns (unless user explicitly chose local demo mode)
  if (localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) !== 'local') {
    const queue = JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_SALES_QUEUE) || '[]');
    queue.push(newSale);
    localStorage.setItem(STORAGE_KEYS.PENDING_SALES_QUEUE, JSON.stringify(queue));
  }

  return { ok: true, mode: 'local' };
}

async function updateLotCostAndFloatDB(lotId, newCost, newFloat, extraFields = null) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return false;

  const cleanCost = roundMoney(newCost);
  const cleanFloat = roundMoney(newFloat);
  let savedToCloud = false;

  if (!isOfflineMode && supabaseClient) {
    try {
      const payload = { cost: cleanCost, float_money: cleanFloat };
      if (extraFields && typeof extraFields === 'object') {
        Object.assign(payload, extraFields);
      }

      let { error } = await supabaseClient
        .from('lots')
        .update(payload)
        .eq('id', lotId);

      if (error) {
        // Fallback if order_data / lot_note / float_money column not yet migrated
        const { error: err2 } = await supabaseClient
          .from('lots')
          .update({ cost: cleanCost, float_money: cleanFloat })
          .eq('id', lotId);

        if (err2) {
          const { error: err3 } = await supabaseClient
            .from('lots')
            .update({ cost: cleanCost })
            .eq('id', lotId);
          if (err3) throw err3;
        }
      }
      savedToCloud = true;
    } catch (e) {
      console.error('Error updating cost in Supabase:', e);
    }
  }

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const idx = localLots.findIndex(l => l.id === lotId);
  if (idx !== -1) {
    localLots[idx].cost = cleanCost;
    localLots[idx].float_money = cleanFloat;
    if (extraFields && typeof extraFields === 'object') {
      Object.assign(localLots[idx], extraFields);
    }
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  return savedToCloud || isOfflineMode;
}

async function updateDailySaleDB(saleId, lotId, newAmount, newShift, newNote) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return false;
  const cleanAmount = roundMoney(newAmount);

  if (!isOfflineMode && supabaseClient) {
    try {
      let { error } = await supabaseClient
        .from('daily_sales')
        .update({
          amount: cleanAmount,
          shift: newShift,
          note: newNote
        })
        .eq('id', saleId);

      if (error) {
        const { error: err2 } = await supabaseClient
          .from('daily_sales')
          .update({ amount: cleanAmount })
          .eq('id', saleId);
        if (err2) throw err2;
      }

      await recalculateAndSyncLotTotalDB(lotId);
      return true;
    } catch (e) {
      console.error('Error updating sale in Supabase:', e);
    }
  }

  // LocalStorage
  const allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  const sIdx = allSales.findIndex(s => s.id === saleId);
  if (sIdx !== -1) {
    allSales[sIdx].amount = cleanAmount;
    allSales[sIdx].shift = newShift;
    allSales[sIdx].note = newNote;
    localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));
  }

  const lotSales = allSales.filter(s => s.lot_id === lotId);
  const newTotal = roundMoney(lotSales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0));

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lIdx = localLots.findIndex(l => l.id === lotId);
  if (lIdx !== -1) {
    localLots[lIdx].total_collected = newTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  return true;
}

async function deleteDailySaleDB(saleId, lotId) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return false;

  if (!isOfflineMode && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from('daily_sales')
        .delete()
        .eq('id', saleId);
      if (error) throw error;

      await recalculateAndSyncLotTotalDB(lotId);
      return true;
    } catch (e) {
      console.error('Error deleting sale in Supabase:', e);
    }
  }

  // LocalStorage
  let allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
  allSales = allSales.filter(s => s.id !== saleId);
  localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(allSales));

  const lotSales = allSales.filter(s => s.lot_id === lotId);
  const newTotal = roundMoney(lotSales.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0));

  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const lIdx = localLots.findIndex(l => l.id === lotId);
  if (lIdx !== -1) {
    localLots[lIdx].total_collected = newTotal;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  }
  return true;
}

async function closeActiveLotAndStartNew(currentLotId, nextLotCost = null) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return null;

  const nowIso = new Date().toISOString();
  const prevFloat = activeLot && activeLot.float_money !== undefined ? roundMoney(activeLot.float_money) : 500;
  const targetNextCost = nextLotCost !== null && nextLotCost !== undefined
    ? parseLotCost(nextLotCost, 5000)
    : parseLotCost(activeLot?.cost, 5000);

  if (!isOfflineMode && supabaseClient) {
    try {
      // Ensure current lot total_collected is accurately synced before closing
      await recalculateAndSyncLotTotalDB(currentLotId);

      // 1. Update current lot to closed
      const { error: closeErr } = await supabaseClient
        .from('lots')
        .update({
          status: 'closed',
          closed_at: nowIso
        })
        .eq('id', currentLotId);
      if (closeErr) throw closeErr;

      // 2. Create brand new active lot
      let { data: newLot, error: newErr } = await supabaseClient
        .from('lots')
        .insert([{
          cost: targetNextCost,
          float_money: prevFloat,
          total_collected: 0,
          status: 'active'
        }])
        .select()
        .single();

      if (newErr) {
        const { data: fallbackLot, error: err2 } = await supabaseClient
          .from('lots')
          .insert([{ cost: targetNextCost, total_collected: 0, status: 'active' }])
          .select()
          .single();
        if (err2) throw err2;
        newLot = fallbackLot;
      }

      return newLot;
    } catch (e) {
      console.error('Error closing lot in Supabase:', e);
      showToast('เกิดข้อผิดพลาดในการปิดลอตใน Supabase', 'error');
      return null;
    }
  }

  // LocalStorage Fallback
  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  const idx = localLots.findIndex(l => l.id === currentLotId);
  if (idx !== -1) {
    localLots[idx].status = 'closed';
    localLots[idx].closed_at = nowIso;
  }

  const newLot = {
    id: generateUUID(),
    cost: targetNextCost,
    float_money: prevFloat,
    total_collected: 0,
    status: 'active',
    created_at: nowIso,
    closed_at: null
  };
  localLots.unshift(newLot);
  localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(localLots));
  return newLot;
}

async function fetchClosedLotsWithDetails() {
  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('lots')
        .select('*')
        .eq('status', 'closed')
        .order('closed_at', { ascending: false });

      if (error) throw error;
      const list = data || [];
      list.forEach(l => syncLotMetadataFromCloudRow(l));
      return list;
    } catch (e) {
      console.error('Error fetching closed lots:', e);
    }
  }

  // LocalStorage Fallback
  const localLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
  return localLots
    .filter(l => l.status === 'closed')
    .sort((a, b) => new Date(b.closed_at || b.created_at) - new Date(a.closed_at || a.created_at));
}

// ========================================================
// 3. UI Rendering & Business Logic (Sections 1, 2, 3)
// ========================================================

// --- SECTION 1: DASHBOARD & ANALYTICS ---
async function loadActiveLotData() {
  activeLot = await fetchActiveLot();
  if (!activeLot) return;

  currentLotSales = await fetchSalesForLot(activeLot.id);
  closedLots = await fetchClosedLotsWithDetails();
  renderDashboardUI();
  renderAnalyticsUI();
}

function renderDashboardUI() {
  if (!activeLot) return;

  const cost = parseFloat(activeLot.cost) || 5000;
  const floatMoney = activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;
  const collected = parseFloat(activeLot.total_collected) || 0;
  const diff = collected - cost;
  const percentage = cost > 0 ? (collected / cost) * 100 : 0;

  // Header & Meta (แสดง "ลอตที่ 1", "ลอตที่ 2" เข้าใจง่าย แทนรหัสเทคนิคยาวๆ)
  const lotNum = (closedLots && closedLots.length > 0) ? closedLots.length + 1 : 1;
  const lotLabel = `ลอตที่ ${lotNum}`;
  const elActiveLotId = document.getElementById('active-lot-id');
  const elInputTargetLot = document.getElementById('input-target-lot');
  if (elActiveLotId) elActiveLotId.innerText = lotLabel;
  if (elInputTargetLot) elInputTargetLot.innerText = lotLabel;
  
  const createdDate = new Date(activeLot.created_at);
  document.getElementById('active-lot-date').innerText = `เปิดลอต: ${createdDate.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}`;

  // Metric Boxes
  document.getElementById('dash-cost').innerText = `฿${cost.toLocaleString('th-TH')}`;
  const floatEl = document.getElementById('dash-float-money');
  if (floatEl) floatEl.innerText = `฿${floatMoney.toLocaleString('th-TH')}`;
  const inputFloatBadge = document.getElementById('input-float-badge');
  if (inputFloatBadge) inputFloatBadge.innerText = `เงินทอน: ฿${floatMoney.toLocaleString('th-TH')}`;

  document.getElementById('dash-collected').innerText = `฿${collected.toLocaleString('th-TH')}`;
  document.getElementById('dash-sales-count').innerText = `${currentLotSales.length} รายการที่บันทึกแล้ว`;

  // Progress Bar
  const displayProgressWidth = Math.min(100, Math.max(0, percentage));
  const progressBar = document.getElementById('dash-progress-bar');
  const progressPercent = document.getElementById('dash-progress-percent');
  const remainingLabel = document.getElementById('dash-remaining-label');

  progressPercent.innerText = `${percentage.toFixed(1)}%`;
  progressBar.style.width = `${displayProgressWidth}%`;

  // --- COLOR-CODED ALERTS (ปรับตามสัดส่วนของต้นทุนตั้งต้น เช่น 80% = 4,000 จาก 5,000) ---
  const warningThreshold = Math.round(cost * 0.8); // 4,000 when cost is 5,000
  const alertBox = document.getElementById('dash-status-alert');
  const alertIcon = document.getElementById('dash-alert-icon');
  const alertTitle = document.getElementById('dash-alert-title');
  const alertDesc = document.getElementById('dash-alert-desc');

  if (collected <= warningThreshold) {
    // ระดับ 1: 0 - 80% ของต้นทุน (แถบสีฟ้าไอเย็นตู้แช่วอลล์ / ปกติ)
    progressBar.className = 'h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-sky-400 via-cyan-500 to-blue-500 freezer-bar-shimmer';
    remainingLabel.innerText = `❄️ ยังขาดอีก ฿${(cost - collected).toLocaleString('th-TH')} จะคืนทุน`;
    
    alertBox.className = 'p-4 rounded-2xl flex items-start space-x-3.5 transition-all duration-300 bg-sky-50 border border-sky-200 text-sky-900';
    alertIcon.innerHTML = '<i class="fa-solid fa-snowflake text-sky-500 text-xl"></i>';
    alertTitle.innerText = '❄️ สถานะตู้แช่วอลล์: ไอศกรีมเต็มตู้พร้อมขาย!';
    alertDesc.innerText = `เก็บยอดได้ ฿${collected.toLocaleString('th-TH')} (เป้าคืนทุน ฿${cost.toLocaleString('th-TH')}) ไอศกรีมในตู้แช่ยังมีเพียงพอสำหรับเด็ก ๆ`;

  } else if (collected > warningThreshold && collected <= cost) {
    // ระดับ 2: 80% - 100% ของต้นทุน (แถบสีเหลืองส้ม / กระดิ่งรถวอลล์เตือนใกล้หมดตู้)
    progressBar.className = 'h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-amber-400 via-orange-500 to-rose-500 freezer-bar-shimmer';
    remainingLabel.innerText = `🔔 ใกล้คืนทุนแล้ว! ขาดอีกเพียง ฿${(cost - collected).toLocaleString('th-TH')}`;

    alertBox.className = 'p-4 rounded-2xl flex items-start space-x-3.5 transition-all duration-300 bg-amber-50 border-2 border-amber-300 text-amber-950 shadow-sm';
    alertIcon.innerHTML = '<i class="fa-solid fa-bell text-amber-600 text-xl walls-bell-anim"></i>';
    alertTitle.innerText = '🔔 ไอศกรีมใกล้เกลี้ยงตู้แล้ว! เตรียมสั่งเซลล์วอลล์ลอตใหม่!';
    alertDesc.innerText = `ยอดสะสมแตะ ฿${collected.toLocaleString('th-TH')} แล้ว กดไปที่แท็บ "สินค้า & ใบสั่งซื้อ" เพื่อออกใบสั่งซื้อ PDF ส่งร้านค้าได้เลย`;

  } else {
    // ระดับ 3: > ต้นทุน (แถบสีเขียวมรกต / คืนทุนแล้ว กำไรล้วน ๆ)
    progressBar.className = 'h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r from-emerald-400 via-teal-500 to-green-600 shadow-sm freezer-bar-shimmer';
    remainingLabel.innerHTML = `<span class="text-emerald-600 font-bold">❤️ คืนทุนครบ 100% แล้ว!</span>`;

    alertBox.className = 'p-4 rounded-2xl flex items-start space-x-3.5 transition-all duration-300 bg-emerald-50 border-2 border-emerald-300 text-emerald-950 shadow-sm';
    alertIcon.innerHTML = '<i class="fa-solid fa-heart text-[#E4002B] text-xl animate-bounce"></i>';
    alertTitle.innerText = `🎉 คืนทุนแล้ว! กำไรสุทธิปัจจุบัน: +฿${diff.toLocaleString('th-TH')} บาท`;
    alertDesc.innerText = `ทะลุทุน ฿${cost.toLocaleString('th-TH')} เรียบร้อย! ทุกแท่งที่ขายได้ตอนนี้คือกำไรล้วน ๆ ของโครงการโรงเรียน`;
  }

  // Render Recent Sales List in Current Lot
  renderCurrentLotSalesList();
}

function renderCurrentLotSalesList() {
  const container = document.getElementById('dash-sales-list');
  const countBadge = document.getElementById('dash-recent-count');
  countBadge.innerText = `${currentLotSales.length} รายการ`;

  if (currentLotSales.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-xs text-slate-400">
        <i class="fa-solid fa-receipt text-3xl text-slate-300 mb-2 block"></i>
        ยังไม่มีการบันทึกยอดเงินในลอตนี้<br>กดปุ่ม "บันทึกยอดเงินสดวันนี้" เพื่อเริ่มต้น
      </div>
    `;
    return;
  }

  container.innerHTML = currentLotSales.map((sale, idx) => {
    const saleDate = new Date(sale.created_at);
    const dateFormatted = saleDate.toLocaleDateString('th-TH', { 
      day: 'numeric', 
      month: 'short' 
    });
    const timeFormatted = saleDate.toLocaleTimeString('th-TH', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    const isNoSale = parseFloat(sale.amount) === 0;
    const isAfternoon = sale.shift === 'afternoon';
    const shiftBadge = isNoSale
      ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-bold">⛔ งดขายวันนี้</span>'
      : isAfternoon
        ? '<span class="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10px] font-bold">🌤️ พักบ่าย</span>'
        : '<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold">☀️ พักเที่ยง</span>';

    const noteHtml = sale.note
      ? `<p class="text-[11px] ${isNoSale ? 'text-rose-600 font-semibold' : 'text-slate-500'} mt-0.5"><i class="fa-regular fa-comment-dots ${isNoSale ? 'text-rose-400' : 'text-slate-400'} mr-1"></i>${escapeHtml(sale.note)}</p>`
      : '';

    const amountBadge = isNoSale
      ? '<span class="font-bold text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200">งดขาย (฿0)</span>'
      : `<span class="font-extrabold text-sm text-slate-900 font-mono">+฿${parseFloat(sale.amount).toLocaleString('th-TH')}</span>`;

    return `
      <div class="py-3 first:pt-1 flex items-start justify-between gap-2 text-xs group">
        <div class="flex items-start space-x-2.5 min-w-0">
          <div class="w-7 h-7 rounded-lg ${isNoSale ? 'bg-rose-50 text-rose-500' : 'bg-slate-100 text-slate-500'} flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5">
            ${currentLotSales.length - idx}
          </div>
          <div class="min-w-0">
            <div class="flex items-center flex-wrap gap-1.5">
              ${shiftBadge}
              <span class="text-[11px] text-slate-400">${dateFormatted} • ${timeFormatted} น.</span>
            </div>
            ${noteHtml}
          </div>
        </div>
        <div class="flex items-center space-x-2 shrink-0">
          ${amountBadge}
          <button onclick="openEditSaleModal('${sale.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-400 hover:text-blue-600 flex items-center justify-center transition" title="แก้ไขหรือลบรายการนี้">
            <i class="fa-solid fa-pen text-[10px]"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// --- ANALYTICS & DAILY TREND CHART ---
function renderAnalyticsUI() {
  const avgDaysEl = document.getElementById('stat-avg-days-per-lot');
  const avgDaysSubEl = document.getElementById('stat-avg-days-sub');
  const avgDailySaleEl = document.getElementById('stat-avg-daily-sale');
  const estDaysLeftEl = document.getElementById('stat-est-days-left');
  const lunchTotalEl = document.getElementById('stat-lunch-total');
  const lunchPctEl = document.getElementById('stat-lunch-pct');
  const afternoonTotalEl = document.getElementById('stat-afternoon-total');
  const afternoonPctEl = document.getElementById('stat-afternoon-pct');
  const chartContainer = document.getElementById('daily-trend-chart');

  if (!avgDaysEl || !activeLot) return;

  // 1. Calculate Average Days per Closed Lot (or Active Lot elapsed days)
  let totalDays = 0;
  let countedLots = 0;

  closedLots.forEach(lot => {
    if (lot.created_at && lot.closed_at) {
      const start = new Date(lot.created_at);
      const end = new Date(lot.closed_at);
      const diffDays = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
      totalDays += diffDays;
      countedLots++;
    }
  });

  if (countedLots > 0) {
    const avgLotDays = totalDays / countedLots;
    avgDaysEl.innerText = `${avgLotDays.toFixed(1)} วัน`;
    avgDaysSubEl.innerText = `เฉลี่ยจาก ${countedLots} ลอตที่ปิดแล้ว`;
  } else {
    // Group unique calendar days in current active lot
    const uniqueDaysInActive = new Set(
      currentLotSales.map(s => new Date(s.created_at).toLocaleDateString('th-TH'))
    ).size;
    avgDaysEl.innerText = uniqueDaysInActive > 0 ? `${uniqueDaysInActive} วัน` : 'เพิ่งเริ่ม';
    avgDaysSubEl.innerText = 'จำนวนวันที่ขายในลอตปัจจุบัน';
  }

  // 2. Group Current Lot Sales by Day (YYYY-MM-DD) & Shift
  const dailyMap = {}; // { '2026-10-31': { label: '31 ต.ค.', lunch: 0, afternoon: 0, total: 0 } }
  let lunchSum = 0;
  let afternoonSum = 0;

  // Iterate chronological order (oldest to newest)
  const chronologicalSales = [...currentLotSales].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  chronologicalSales.forEach(sale => {
    const d = new Date(sale.created_at);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    const amt = parseFloat(sale.amount) || 0;

    if (!dailyMap[dayKey]) {
      dailyMap[dayKey] = { label, lunch: 0, afternoon: 0, total: 0 };
    }

    if (sale.shift === 'afternoon') {
      dailyMap[dayKey].afternoon += amt;
      afternoonSum += amt;
    } else {
      dailyMap[dayKey].lunch += amt;
      lunchSum += amt;
    }
    dailyMap[dayKey].total += amt;
  });

  const dayEntries = Object.values(dailyMap);
  const numSellingDays = dayEntries.length;
  const totalCollected = parseFloat(activeLot.total_collected) || 0;
  const cost = parseFloat(activeLot.cost) || 5000;

  // Average daily sale & estimated days to break-even
  const avgDaily = numSellingDays > 0 ? Math.round(totalCollected / numSellingDays) : 0;
  avgDailySaleEl.innerText = `฿${avgDaily.toLocaleString('th-TH')}`;

  if (totalCollected >= cost) {
    estDaysLeftEl.innerText = 'คืนทุนเรียบร้อยแล้ว!';
  } else if (avgDaily > 0) {
    const estMoreDays = Math.ceil((cost - totalCollected) / avgDaily);
    estDaysLeftEl.innerText = `คาดว่าอีก ~${estMoreDays} วันคืนทุน`;
  } else {
    estDaysLeftEl.innerText = 'รอข้อมูลการขายเพื่อคาดการณ์';
  }

  // Shift Breakdown
  const grandShiftTotal = lunchSum + afternoonSum;
  const lunchPct = grandShiftTotal > 0 ? Math.round((lunchSum / grandShiftTotal) * 100) : 0;
  const afternoonPct = grandShiftTotal > 0 ? (100 - lunchPct) : 0;

  lunchTotalEl.innerText = `฿${lunchSum.toLocaleString('th-TH')}`;
  lunchPctEl.innerText = `สัดส่วน ${lunchPct}% ของลอตนี้`;
  afternoonTotalEl.innerText = `฿${afternoonSum.toLocaleString('th-TH')}`;
  afternoonPctEl.innerText = `สัดส่วน ${afternoonPct}% ของลอตนี้`;

  // 3. Render Bar Chart
  if (dayEntries.length === 0) {
    chartContainer.innerHTML = `
      <div class="w-full h-full flex items-center justify-center text-xs text-slate-400">
        ยังไม่มีข้อมูลกราฟในลอตนี้ (เมื่อบันทึกยอดขาย กราฟรายวันจะแสดงที่นี่)
      </div>
    `;
    return;
  }

  const maxDayTotal = Math.max(...dayEntries.map(d => d.total), 100);

  chartContainer.innerHTML = dayEntries.map(day => {
    const totalHeightPct = Math.max(12, Math.round((day.total / maxDayTotal) * 100));
    const lunchRatio = day.total > 0 ? Math.round((day.lunch / day.total) * 100) : 100;
    const afternoonRatio = 100 - lunchRatio;

    return `
      <div class="flex-1 min-w-[54px] max-w-[90px] h-full flex flex-col justify-end items-center group">
        <!-- Amount Label Above Bar -->
        <span class="text-[10px] font-mono font-bold text-slate-700 mb-1">฿${day.total.toLocaleString('th-TH')}</span>
        
        <!-- Stacked Bar -->
        <div class="w-9 sm:w-11 bg-slate-200/70 rounded-t-xl overflow-hidden flex flex-col justify-end chart-bar-anim shadow-sm border border-slate-200" 
             style="height: ${totalHeightPct}%"
             title="${day.label}: รวม ฿${day.total.toLocaleString('th-TH')} (เที่ยง ฿${day.lunch.toLocaleString('th-TH')} / บ่าย ฿${day.afternoon.toLocaleString('th-TH')})">
          ${day.afternoon > 0 ? `<div class="w-full bg-sky-500 transition-all" style="height: ${afternoonRatio}%"></div>` : ''}
          ${day.lunch > 0 ? `<div class="w-full bg-amber-500 transition-all" style="height: ${lunchRatio}%"></div>` : ''}
        </div>

        <!-- Date Label Below Bar -->
        <span class="text-[10px] font-semibold text-slate-500 mt-1.5 whitespace-nowrap">${day.label}</span>
      </div>
    `;
  }).join('');
}

// --- SECTION 2: DAILY CASH INPUT (NUMPAD, SHIFT, FLOAT, NOTE) ---
function selectShift(shift) {
  selectedShift = shift;
  const lunchBtn = document.getElementById('shift-btn-lunch');
  const afternoonBtn = document.getElementById('shift-btn-afternoon');

  if (shift === 'lunch') {
    lunchBtn.className = 'shift-btn active py-2.5 px-4 rounded-xl border border-slate-200 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
    afternoonBtn.className = 'shift-btn py-2.5 px-4 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
  } else {
    afternoonBtn.className = 'shift-btn active py-2.5 px-4 rounded-xl border border-slate-200 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
    lunchBtn.className = 'shift-btn py-2.5 px-4 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 text-xs sm:text-sm font-bold transition flex items-center justify-center space-x-2';
  }
}

function appendNoteTag(tagText, isNoSaleDay = false) {
  const noteInput = document.getElementById('sale-note-input');
  if (!noteInput) return;
  const current = noteInput.value.trim();
  noteInput.value = current ? `${current}, ${tagText}` : tagText;

  if (isNoSaleDay) {
    currentInputAmount = '0';
    const deductCheckbox = document.getElementById('deduct-float-checkbox');
    if (deductCheckbox) deductCheckbox.checked = false;
    updateInputField();
    playWallsChime('tap');
    showToast(`เลือกหมายเหตุ "${tagText}" (ตั้งยอด ฿0 สำหรับวันงดขายแล้ว กดปุ่มบันทึกได้เลย)`, 'info');
  }
}

function numpadInput(digit) {
  if (currentInputAmount === '0' && digit !== '.') {
    currentInputAmount = digit;
  } else {
    if (currentInputAmount.length < 7) {
      currentInputAmount += digit;
    }
  }
  updateInputField();
}

function numpadClear() {
  currentInputAmount = '';
  updateInputField();
}

function numpadBackspace() {
  currentInputAmount = currentInputAmount.slice(0, -1);
  updateInputField();
}

function addPresetAmount(val) {
  const current = parseFloat(currentInputAmount) || 0;
  currentInputAmount = (current + val).toString();
  playWallsChime('tap');
  updateInputField();
}

function updateInputField() {
  const inputEl = document.getElementById('cash-input-field');
  const deductCheckbox = document.getElementById('deduct-float-checkbox');
  const labelEl = document.getElementById('cash-input-label');
  const netBadge = document.getElementById('net-sale-badge');
  const previewText = document.getElementById('float-calc-preview');

  if (!inputEl) return;
  inputEl.value = currentInputAmount;

  const rawVal = parseFloat(currentInputAmount) || 0;
  const floatAmt = activeLot && activeLot.float_money !== undefined ? parseFloat(activeLot.float_money) : 500;

  if (deductCheckbox && deductCheckbox.checked) {
    labelEl.innerText = 'เงินสดรวมในกล่อง (รวมเงินทอนตั้งต้น):';
    const netSale = Math.max(0, rawVal - floatAmt);
    netBadge.classList.remove('hidden');
    netBadge.innerText = `ยอดขายสุทธิ: ฿${netSale.toLocaleString('th-TH')}`;
    previewText.innerHTML = rawVal > 0
      ? `เงินนับรวม <strong>฿${rawVal.toLocaleString('th-TH')}</strong> - หักเงินทอน <strong>฿${floatAmt.toLocaleString('th-TH')}</strong> = บันทึกยอดขายจริง <strong class="text-emerald-700">฿${netSale.toLocaleString('th-TH')}</strong>`
      : `กรอกเงินรวมในกล่อง ระบบจะหักเงินทอน ฿${floatAmt.toLocaleString('th-TH')} ออกให้อัตโนมัติ`;
  } else if (labelEl && netBadge && previewText) {
    labelEl.innerText = 'ยอดเงินสดที่ขายได้สุทธิ (บาท):';
    netBadge.classList.add('hidden');
    previewText.innerText = 'หากติ๊กถูก: เพียงกรอกเงินทั้งหมดที่นับได้ในกล่อง ระบบจะหักเงินทอนตั้งต้นออกให้เอง';
  }
}

function initNumpadKeyboardSupport() {
  window.addEventListener('keydown', (e) => {
    const inputTab = document.getElementById('tab-input');
    if (!inputTab || inputTab.classList.contains('hidden')) return;

    // Do not intercept keys if user is typing inside a text input / textarea (e.g. Note field or Modal)
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    const isReadonlyInput = document.activeElement && document.activeElement.id === 'cash-input-field';
    if ((activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') && !isReadonlyInput) {
      return;
    }

    if (e.key >= '0' && e.key <= '9') {
      numpadInput(e.key);
    } else if (e.key === 'Backspace') {
      numpadBackspace();
    } else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
      numpadClear();
    } else if (e.key === 'Enter') {
      submitDailySale();
    }
  });
}

async function submitDailySale() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;

  const noteInput = document.getElementById('sale-note-input');
  const noteText = noteInput ? noteInput.value.trim() : '';
  const rawInput = currentInputAmount === '' ? (noteText ? 0 : NaN) : parseFloat(currentInputAmount);

  if (isNaN(rawInput) || rawInput < 0 || (rawInput === 0 && !noteText)) {
    showToast('กรุณากรอกยอดเงินสด (มากกว่า 0 บาท) หรือระบุหมายเหตุกรณีวันที่ไม่ได้ขาย', 'error');
    return;
  }

  if (!activeLot) {
    showToast('ไม่พบลอตการขายที่กำลังทำงาน กรุณารีเฟรชระบบ', 'error');
    return;
  }

  const deductCheckbox = document.getElementById('deduct-float-checkbox');
  const floatAmt = activeLot.float_money !== undefined ? roundMoney(activeLot.float_money) : 500;
  let finalAmount = roundMoney(rawInput);
  let floatDeducted = 0;

  if (rawInput > 0 && deductCheckbox && deductCheckbox.checked) {
    if (rawInput <= floatAmt) {
      showToast(`ยอดเงินรวมในกล่อง (฿${rawInput}) น้อยกว่าหรือเท่ากับเงินทอนตั้งต้น (฿${floatAmt})`, 'error');
      return;
    }
    finalAmount = roundMoney(rawInput - floatAmt);
    floatDeducted = floatAmt;
  }

  const btnSubmit = document.getElementById('btn-submit-sale');
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> กำลังบันทึกยอด...';

  const result = await insertDailySale(activeLot.id, finalAmount, selectedShift, noteText, floatDeducted);
  const isOk = result && typeof result === 'object' ? result.ok : !!result;
  const savedMode = result && typeof result === 'object' ? result.mode : 'cloud';

  btnSubmit.disabled = false;
  btnSubmit.innerHTML = '<i class="fa-solid fa-circle-check text-xl"></i> <span>บันทึกยอดเงินสด (Submit)</span>';

  if (isOk) {
    playWallsChime('success');
    const shiftLabel = selectedShift === 'afternoon' ? 'พักบ่าย' : 'พักเที่ยง';
    const isQueuedOffline = savedMode === 'local' && localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) !== 'local';

    if (isQueuedOffline) {
      showToast(`⚠️ เน็ตสะดุด: บันทึกยอด +฿${finalAmount.toLocaleString('th-TH')} ไว้ในเครื่องแล้ว (จะซิงค์ขึ้นคลาวด์อัตโนมัติเมื่อออนไลน์)`, 'warning');
    } else if (finalAmount === 0) {
      showToast(`📌 บันทึกวันงดขาย (${noteText}) เรียบร้อยแล้ว!`, 'success');
    } else {
      showToast(`🔔 กริ๊งๆ! บันทึกยอดกะ${shiftLabel} +฿${finalAmount.toLocaleString('th-TH')} บาท เรียบร้อยแล้ว!`, 'success');
    }
    currentInputAmount = '';
    if (noteInput) noteInput.value = '';
    if (deductCheckbox) deductCheckbox.checked = false;
    updateInputField();

    await loadActiveLotData();
    switchTab('dashboard');
  }
}

// --- Active Lot Order & Profit Forecast System (Idea 1) ---
let currentLotOrderMode = 'catalog'; // 'catalog' | 'quick'
let currentLotOrderQuantities = {}; // { [productId]: qty }

function getLotOrderData(lotId) {
  if (!lotId) return null;
  try {
    if (activeLot && activeLot.id === lotId && activeLot.order_data && typeof activeLot.order_data === 'object') {
      return activeLot.order_data;
    }
    const all = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_ORDERS) || '{}');
    return all[lotId] || null;
  } catch (e) {
    return null;
  }
}

function saveLotOrderData(lotId, orderData) {
  if (!lotId) return null;
  try {
    const cleanPayload = {
      ...orderData,
      totalCost: roundMoney(orderData.totalCost || 0),
      totalRevenue: roundMoney(orderData.totalRevenue || 0),
      totalProfit: roundMoney((orderData.totalRevenue || 0) - (orderData.totalCost || 0)),
      updatedAt: new Date().toISOString()
    };
    const all = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_ORDERS) || '{}');
    all[lotId] = cleanPayload;
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOT_ORDERS, JSON.stringify(all));
    if (activeLot && activeLot.id === lotId) {
      activeLot.order_data = cleanPayload;
    }
    return cleanPayload;
  } catch (e) {
    console.error('Failed to save lot order data:', e);
    return null;
  }
}

function renderActiveLotForecastCard() {
  const card = document.getElementById('hist-active-forecast-card');
  if (!card) return;

  if (!activeLot) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const isReadOnly = typeof isDirectorViewMode === 'function' && isDirectorViewMode();
  const btnContainer = document.getElementById('hist-forecast-btn-container');
  if (btnContainer) {
    btnContainer.classList.toggle('hidden', isReadOnly);
  }

  const lotNum = (closedLots.length + 1);
  const lotTitleEl = document.getElementById('hist-forecast-lot-title');
  if (lotTitleEl) lotTitleEl.innerText = `งวดที่ ${lotNum} (ลอตปัจจุบัน)`;

  const startObj = new Date(activeLot.created_at || new Date());
  const dateStr = startObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  const datesEl = document.getElementById('hist-forecast-lot-dates');
  if (datesEl) datesEl.innerText = `• เริ่มเปิดขาย ${dateStr}`;

  const currentCost = parseLotCost(activeLot.cost, 5000);
  const collected = roundMoney(activeLot.total_collected || 0);

  // Check if we have saved itemized order data for this lot
  const orderData = getLotOrderData(activeLot.id);

  let cost = currentCost;
  let revenue = 0;
  let profit = 0;
  let marginPct = '0.0';
  let hasItemized = false;
  let itemsCountText = '';
  let itemsPillHtml = '';

  if (orderData && parseFloat(orderData.totalRevenue) > 0) {
    hasItemized = true;
    cost = parseLotCost(orderData.totalCost, currentCost);
    revenue = roundMoney(orderData.totalRevenue);
    profit = roundMoney(revenue - cost);
    marginPct = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : '0.0';

    if (orderData.mode === 'catalog' && orderData.items && orderData.items.length > 0) {
      itemsCountText = `สั่งไอศกรีม ${orderData.totalBoxes || 0} ลัง (${orderData.totalPieces || 0} แท่ง)`;
      const topItems = orderData.items.slice(0, 4).map(it => `${escapeAttr(it.name)} (${it.qty} ลัง)`).join(', ');
      const more = orderData.items.length > 4 ? ` และอีก ${orderData.items.length - 4} รายการ` : '';
      itemsPillHtml = `
        <span class="text-slate-700 font-semibold">📦 ${itemsCountText}:</span>
        <span class="text-slate-600 truncate max-w-md">${topItems}${more}</span>
        ${!isReadOnly ? `<button type="button" onclick="openActiveLotOrderModal()" class="text-rose-600 hover:text-rose-700 font-bold hover:underline cursor-pointer ml-auto">แก้ไขรายการ</button>` : ''}
      `;
    } else {
      itemsCountText = `กรอกยอดรวมด่วน (${orderData.totalBoxes || 0} ลัง • ${orderData.totalPieces || 0} แท่ง)`;
      itemsPillHtml = `
        <span class="text-slate-700 font-semibold">⚡ ${itemsCountText}</span>
        ${!isReadOnly ? `<button type="button" onclick="openActiveLotOrderModal()" class="text-rose-600 hover:text-rose-700 font-bold hover:underline cursor-pointer ml-auto">แก้ไขรายการ</button>` : ''}
      `;
    }
  } else {
    itemsPillHtml = `
      <span class="text-amber-800 font-medium">💡 ยังไม่ได้ระบุรายการไอศกรีมที่สั่งในลอตนี้ กรุณากดปุ่มระบุรายการสั่งซื้อเพื่อคำนวณยอดขายและกำไรที่จะได้</span>
      ${!isReadOnly ? `<button type="button" onclick="openActiveLotOrderModal()" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold text-[10px] cursor-pointer shadow-2xs ml-auto">+ ระบุรายการสั่งซื้อจริง</button>` : ''}
    `;
  }

  // Update elements
  const costEl = document.getElementById('hist-forecast-cost');
  if (costEl) costEl.innerText = `฿${cost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const costSub = document.getElementById('hist-forecast-cost-sub');
  if (costSub) costSub.innerText = hasItemized ? (itemsCountText || 'ค่าไอศกรีมตามบิล') : 'ค่าไอศกรีมตั้งต้น (รอระบุบิล)';

  const revEl = document.getElementById('hist-forecast-revenue');
  const revSub = document.getElementById('hist-forecast-revenue-sub');
  if (revEl) {
    revEl.innerText = hasItemized
      ? `฿${revenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : 'รอระบุรายการ';
  }
  if (revSub) {
    revSub.innerText = hasItemized ? 'ราคาขายปลีกรวมทุกแท่ง' : 'กดปุ่มใส่รายการไอติมด้านบน';
  }

  const profitEl = document.getElementById('hist-forecast-profit');
  const profitSub = document.getElementById('hist-forecast-profit-sub');
  const marginBadge = document.getElementById('hist-forecast-margin-badge');

  if (hasItemized) {
    if (profitEl) {
      profitEl.innerText = `${profit >= 0 ? '+' : ''}฿${profit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      profitEl.className = `font-mono font-black text-lg sm:text-2xl tabular-nums ${profit >= 0 ? 'text-emerald-700' : 'text-rose-600'}`;
    }
    if (profitSub) profitSub.innerText = 'กำไรสุทธิเตรียมเข้ากระปุก';
    if (marginBadge) marginBadge.innerText = `${profit >= 0 ? '+' : ''}${marginPct}%`;
  } else {
    if (profitEl) {
      profitEl.innerText = 'รอคำนวณ';
      profitEl.className = 'font-mono font-bold text-base sm:text-xl text-emerald-700/70 tabular-nums';
    }
    if (profitSub) profitSub.innerText = 'ระบุรายการไอติมเพื่อดูกำไร';
    if (marginBadge) marginBadge.innerText = 'รอข้อมูล';
  }

  const colEl = document.getElementById('hist-forecast-collected');
  if (colEl) colEl.innerText = `฿${collected.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const targetGoal = hasItemized && revenue > 0 ? revenue : cost;
  const progressPct = targetGoal > 0 ? Math.min(100, Math.round((collected / targetGoal) * 1000) / 10) : 0;
  const pctEl = document.getElementById('hist-forecast-progress-pct');
  if (pctEl) pctEl.innerText = `${progressPct.toFixed(1)}%`;

  const remaining = roundMoney(Math.max(0, targetGoal - collected));
  const colSub = document.getElementById('hist-forecast-collected-sub');
  if (colSub) {
    if (hasItemized) {
      colSub.innerText = remaining > 0 ? `เหลืออีก ฿${remaining.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} จะหมดตู้` : '🎉 ขายหมดตู้ตามเป้าแล้ว!';
    } else {
      colSub.innerText = remaining > 0 ? `อีก ฿${remaining.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} จะคืนทุน` : '🎉 คืนทุนครบแล้ว!';
    }
  }

  const statusLabel = document.getElementById('hist-forecast-status-label');
  if (statusLabel) {
    statusLabel.innerText = hasItemized
      ? `เก็บเงินได้ ฿${collected.toLocaleString('th-TH', { minimumFractionDigits: 2 })} จากเป้าหมายยอดขายรวม ฿${revenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`
      : `เก็บเงินได้ ฿${collected.toLocaleString('th-TH', { minimumFractionDigits: 2 })} จากเป้าคืนทุน ฿${cost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  }

  const barEl = document.getElementById('hist-forecast-bar');
  if (barEl) barEl.style.width = `${Math.max(4, Math.min(100, progressPct))}%`;

  const summaryItemsContainer = document.getElementById('hist-forecast-items-summary');
  if (summaryItemsContainer) summaryItemsContainer.innerHTML = itemsPillHtml;

  const btnText = document.getElementById('hist-forecast-btn-text');
  if (btnText) {
    btnText.innerText = hasItemized ? 'แก้ไขรายการไอติมที่สั่ง' : 'ใส่รายการไอติมที่สั่งในลอตนี้';
  }
}

async function openActiveLotOrderModal() {
  if (isDirectorViewMode()) {
    showToast('โหมดผู้บริหาร: สำหรับดูข้อมูลอย่างเดียว ไม่สามารถแก้ไขรายการสั่งซื้อได้', 'warning');
    return;
  }
  if (!activeLot) activeLot = await fetchActiveLot();
  if (!activeLot) return;

  const titleBadge = document.getElementById('lot-order-modal-lot-badge');
  if (titleBadge) {
    const lotNum = (closedLots.length + 1);
    titleBadge.innerText = `ลอตที่ ${lotNum}`;
  }

  // Load saved order data for this lot, or if none, try importing from orderDraftQuantities
  const saved = getLotOrderData(activeLot.id);
  currentLotOrderQuantities = {};

  if (saved && saved.quantities && Object.keys(saved.quantities).length > 0) {
    currentLotOrderQuantities = { ...saved.quantities };
    switchLotOrderMode(saved.mode || 'catalog');
    if (saved.mode === 'quick') {
      const qc = document.getElementById('lot-order-quick-cost');
      const qr = document.getElementById('lot-order-quick-revenue');
      const qp = document.getElementById('lot-order-quick-pieces');
      const qb = document.getElementById('lot-order-quick-boxes');
      if (qc) qc.value = saved.totalCost || '';
      if (qr) qr.value = saved.totalRevenue || '';
      if (qp) qp.value = saved.totalPieces || '';
      if (qb) qb.value = saved.totalBoxes || '';
    }
  } else if (orderDraftQuantities && Object.keys(orderDraftQuantities).length > 0) {
    currentLotOrderQuantities = { ...orderDraftQuantities };
    switchLotOrderMode('catalog');
  } else {
    switchLotOrderMode('catalog');
    const qc = document.getElementById('lot-order-quick-cost');
    if (qc && activeLot.cost) qc.value = activeLot.cost;
  }

  renderLotOrderProductList();
  updateLotOrderSummaryBar();

  const modal = document.getElementById('active-lot-order-modal');
  if (modal) modal.classList.remove('hidden');
}

function switchLotOrderMode(mode) {
  currentLotOrderMode = mode;
  const btnCatalog = document.getElementById('tab-btn-order-catalog');
  const btnQuick = document.getElementById('tab-btn-order-quick');
  const modeCatalog = document.getElementById('lot-order-catalog-mode');
  const modeQuick = document.getElementById('lot-order-quick-mode');

  if (mode === 'catalog') {
    if (btnCatalog) btnCatalog.className = 'px-3 py-1.5 rounded-lg transition bg-white text-rose-700 shadow-2xs font-bold cursor-pointer';
    if (btnQuick) btnQuick.className = 'px-3 py-1.5 rounded-lg transition text-slate-600 hover:text-slate-900 font-bold cursor-pointer';
    if (modeCatalog) modeCatalog.classList.remove('hidden');
    if (modeQuick) modeQuick.classList.add('hidden');
    updateLotOrderSummaryBar();
  } else {
    if (btnCatalog) btnCatalog.className = 'px-3 py-1.5 rounded-lg transition text-slate-600 hover:text-slate-900 font-bold cursor-pointer';
    if (btnQuick) btnQuick.className = 'px-3 py-1.5 rounded-lg transition bg-white text-rose-700 shadow-2xs font-bold cursor-pointer';
    if (modeCatalog) modeCatalog.classList.add('hidden');
    if (modeQuick) modeQuick.classList.remove('hidden');
    updateLotOrderQuickPreview();
  }
}

function renderLotOrderProductList() {
  const container = document.getElementById('lot-order-product-list');
  if (!container) return;

  const searchInput = document.getElementById('lot-order-search');
  const catFilter = document.getElementById('lot-order-cat-filter');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const category = catFilter ? catFilter.value : 'all';

  let list = productCatalog.map(p => ({
    ...p,
    metrics: computeProductMetrics(p)
  }));

  if (category !== 'all') {
    list = list.filter(p => (p.category || '').includes(category));
  }

  if (query) {
    list = list.filter(p => (p.name || '').toLowerCase().includes(query) || (p.category || '').toLowerCase().includes(query));
  }

  if (list.length === 0) {
    container.innerHTML = '<div class="py-8 text-center text-slate-400">ไม่พบรายการไอศกรีมที่ค้นหา</div>';
    return;
  }

  container.innerHTML = list.map(p => {
    const qty = parseInt(currentLotOrderQuantities[p.id] || 0, 10);
    const m = p.metrics;
    const isSelected = qty > 0;

    return `
      <div class="py-2.5 px-3 rounded-2xl transition flex items-center justify-between gap-3 ${isSelected ? 'bg-rose-50/70 border border-rose-200' : 'hover:bg-slate-50 border border-transparent'}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="font-bold text-slate-900 truncate text-xs">${escapeAttr(p.name)}</span>
            <span class="text-[10px] px-1.5 py-0.2 rounded-md bg-slate-100 text-slate-600 font-semibold shrink-0">ขาย ฿${m.retailPiece}</span>
          </div>
          <div class="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>ลังละ ${m.pieces} แท่ง</span>
            <span>•</span>
            <span>ต้นทุน <strong class="text-rose-600 font-mono">฿${m.boxCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</strong></span>
            <span>•</span>
            <span>ยอดขาย <strong class="text-blue-600 font-mono">฿${m.boxRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</strong></span>
            <span>•</span>
            <span class="text-emerald-700 font-semibold font-mono">กำไร +฿${m.boxProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}/ลัง</span>
          </div>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="changeLotOrderQty('${p.id}', -1)" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold flex items-center justify-center transition cursor-pointer">
            <i class="fa-solid fa-minus text-[10px]"></i>
          </button>
          <input type="number" min="0" value="${qty}" onchange="setLotOrderQty('${p.id}', this.value)" class="w-12 h-7 text-center font-mono font-bold text-xs bg-white border ${isSelected ? 'border-rose-400 text-rose-700' : 'border-slate-200 text-slate-800'} rounded-lg outline-none">
          <button type="button" onclick="changeLotOrderQty('${p.id}', 1)" class="w-7 h-7 rounded-lg bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold flex items-center justify-center transition cursor-pointer">
            <i class="fa-solid fa-plus text-[10px]"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function changeLotOrderQty(productId, delta) {
  const current = parseInt(currentLotOrderQuantities[productId] || 0, 10);
  const next = Math.max(0, current + delta);
  if (next === 0) {
    delete currentLotOrderQuantities[productId];
  } else {
    currentLotOrderQuantities[productId] = next;
  }
  renderLotOrderProductList();
  updateLotOrderSummaryBar();
}

function setLotOrderQty(productId, val) {
  const parsed = Math.max(0, parseInt(val, 10) || 0);
  if (parsed === 0) {
    delete currentLotOrderQuantities[productId];
  } else {
    currentLotOrderQuantities[productId] = parsed;
  }
  renderLotOrderProductList();
  updateLotOrderSummaryBar();
}

function updateLotOrderSummaryBar() {
  if (currentLotOrderMode === 'quick') {
    updateLotOrderQuickPreview();
    return;
  }

  let totalBoxes = 0;
  let totalPieces = 0;
  let totalCost = 0;
  let totalRevenue = 0;

  Object.keys(currentLotOrderQuantities).forEach(id => {
    const qty = parseInt(currentLotOrderQuantities[id] || 0, 10);
    if (qty > 0) {
      const p = productCatalog.find(item => item.id === id);
      if (p) {
        const m = computeProductMetrics(p);
        totalBoxes += qty;
        totalPieces += m.pieces * qty;
        totalCost += roundMoney(m.boxCost * qty);
        totalRevenue += roundMoney(m.boxRevenue * qty);
      }
    }
  });

  totalCost = roundMoney(totalCost);
  totalRevenue = roundMoney(totalRevenue);
  const totalProfit = roundMoney(totalRevenue - totalCost);

  const sumBoxes = document.getElementById('lot-order-sum-boxes');
  const sumPieces = document.getElementById('lot-order-sum-pieces');
  const sumCost = document.getElementById('lot-order-sum-cost');
  const sumRevenue = document.getElementById('lot-order-sum-revenue');
  const sumProfit = document.getElementById('lot-order-sum-profit');

  if (sumBoxes) sumBoxes.innerText = totalBoxes;
  if (sumPieces) sumPieces.innerText = totalPieces;
  if (sumCost) sumCost.innerText = `฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (sumRevenue) sumRevenue.innerText = `฿${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (sumProfit) sumProfit.innerText = `${totalProfit >= 0 ? '+' : ''}฿${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function updateLotOrderQuickPreview() {
  const costVal = roundMoney(document.getElementById('lot-order-quick-cost')?.value || 0);
  const revVal = roundMoney(document.getElementById('lot-order-quick-revenue')?.value || 0);
  const piecesVal = parseInt(document.getElementById('lot-order-quick-pieces')?.value, 10) || 0;
  const boxesVal = parseInt(document.getElementById('lot-order-quick-boxes')?.value, 10) || 0;
  const profitVal = roundMoney(revVal - costVal);

  const sumBoxes = document.getElementById('lot-order-sum-boxes');
  const sumPieces = document.getElementById('lot-order-sum-pieces');
  const sumCost = document.getElementById('lot-order-sum-cost');
  const sumRevenue = document.getElementById('lot-order-sum-revenue');
  const sumProfit = document.getElementById('lot-order-sum-profit');

  if (sumBoxes) sumBoxes.innerText = boxesVal;
  if (sumPieces) sumPieces.innerText = piecesVal;
  if (sumCost) sumCost.innerText = `฿${costVal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (sumRevenue) sumRevenue.innerText = `฿${revVal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (sumProfit) sumProfit.innerText = `${profitVal >= 0 ? '+' : ''}฿${profitVal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function importFromPurchaseOrderDraft() {
  if (!orderDraftQuantities || Object.keys(orderDraftQuantities).length === 0) {
    showToast('ยังไม่มีแผนสั่งซื้อในแท็บสินค้า ให้เลือกจำนวนกล่องในหน้านี้ได้เลยครับ', 'info');
    return;
  }
  currentLotOrderQuantities = { ...orderDraftQuantities };
  switchLotOrderMode('catalog');
  renderLotOrderProductList();
  updateLotOrderSummaryBar();
  showToast('ดึงรายการสั่งซื้อจากแท็บสินค้าเรียบร้อยแล้ว!', 'success');
}

async function handleSaveActiveLotOrder() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;

  let totalCost = 0;
  let totalRevenue = 0;
  let totalProfit = 0;
  let totalBoxes = 0;
  let totalPieces = 0;
  const items = [];

  if (currentLotOrderMode === 'catalog') {
    Object.keys(currentLotOrderQuantities).forEach(id => {
      const qty = parseInt(currentLotOrderQuantities[id] || 0, 10);
      if (qty > 0) {
        const p = productCatalog.find(item => item.id === id);
        if (p) {
          const m = computeProductMetrics(p);
          const itemCost = roundMoney(m.boxCost * qty);
          const itemRevenue = roundMoney(m.boxRevenue * qty);
          const itemProfit = roundMoney(itemRevenue - itemCost);
          const itemPieces = m.pieces * qty;

          totalCost = roundMoney(totalCost + itemCost);
          totalRevenue = roundMoney(totalRevenue + itemRevenue);
          totalProfit = roundMoney(totalProfit + itemProfit);
          totalBoxes += qty;
          totalPieces += itemPieces;

          items.push({
            id: p.id,
            name: p.name,
            qty,
            pieces: itemPieces,
            cost: itemCost,
            revenue: itemRevenue,
            profit: itemProfit
          });
        }
      }
    });

    if (items.length === 0) {
      alert('กรุณาระบุจำนวนกล่องไอศกรีมอย่างน้อย 1 รายการ หรือสลับไปใช้โหมดกรอกยอดรวมด่วน');
      return;
    }
  } else {
    // Quick summary mode
    totalCost = roundMoney(document.getElementById('lot-order-quick-cost')?.value || 0);
    totalRevenue = roundMoney(document.getElementById('lot-order-quick-revenue')?.value || 0);
    totalPieces = parseInt(document.getElementById('lot-order-quick-pieces')?.value, 10) || 0;
    totalBoxes = parseInt(document.getElementById('lot-order-quick-boxes')?.value, 10) || 0;
    totalProfit = roundMoney(totalRevenue - totalCost);

    if (totalCost <= 0) {
      alert('กรุณาระบุยอดต้นทุนที่จ่ายบริษัท');
      return;
    }
    if (totalRevenue <= 0) {
      alert('กรุณาระบุยอดขายคาดการณ์เมื่อขายหมด');
      return;
    }
  }

  // Save to lot order store
  const savedPayload = saveLotOrderData(activeLot.id, {
    mode: currentLotOrderMode,
    quantities: currentLotOrderQuantities,
    items,
    totalCost,
    totalRevenue,
    totalProfit,
    totalBoxes,
    totalPieces
  });

  // Update activeLot object and database (including order_data for cloud sync)
  activeLot.cost = totalCost;
  const floatAmt = activeLot.float_money !== undefined ? roundMoney(activeLot.float_money) : 500;
  await updateLotCostAndFloatDB(activeLot.id, totalCost, floatAmt, { order_data: savedPayload });

  closeModal('active-lot-order-modal');
  showToast(`บันทึกรายการสั่งซื้อสำเร็จ! คาดการณ์กำไร +฿${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`, 'success');

  // Re-render Forecast Card, History, Dashboard, and Profit Ledger
  renderActiveLotForecastCard();
  await loadActiveLotData();
  await loadProfitLedgerData();
}

// --- SECTION 3: HISTORY (ประวัติลอต & ตารางสรุปบัญชีรายรับ-รายจ่าย รายลอต) ---
async function loadHistoryData() {
  const listContainer = document.getElementById('history-lots-list');
  const totalProfitEl = document.getElementById('hist-total-profit');
  const ledgerTbody = document.getElementById('hist-lot-ledger-tbody');

  listContainer.innerHTML = '<div class="col-span-full text-center py-10 text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><br>กำลังโหลดประวัติลอต...</div>';

  closedLots = await fetchClosedLotsWithDetails();
  if (!activeLot) activeLot = await fetchActiveLot();

  // Render Active Lot Forecast Card (พยากรณ์กำไรลอตปัจจุบัน)
  renderActiveLotForecastCard();

  // Build chronological list of all lots (oldest = ลอตที่ 1, ..., newest)
  const chronologicalClosed = [...closedLots].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const allLotsChronological = activeLot ? [...chronologicalClosed, activeLot] : chronologicalClosed;

  // Render On-Screen Lot Summary Accounting Table (แสดงเฉพาะลอตที่ปิดรอบแล้ว เพื่อไม่ให้ลอตที่กำลังขายมาดึงกำไรรวมติดลบ)
  if (ledgerTbody) {
    let sumIncome = 0;
    let sumExpense = 0;
    let sumProfit = 0;

    if (chronologicalClosed.length === 0) {
      ledgerTbody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">ยังไม่มีข้อมูลลอตการขายที่ปิดรอบแล้ว (เมื่อกดปิดลอต ข้อมูลสรุปจะแสดงที่นี่)</td></tr>';
    } else {
      ledgerTbody.innerHTML = chronologicalClosed.map((lot, idx) => {
        const lotNumber = idx + 1;
        const income = parseFloat(lot.total_collected) || 0;
        const expense = parseFloat(lot.cost) || 5000;
        const profit = income - expense;

        sumIncome += income;
        sumExpense += expense;
        sumProfit += profit;

        const startObj = new Date(lot.created_at);
        const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
        const startStr = startObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
        const endStr = lot.closed_at
          ? endObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
          : '-';

        const profitClass = profit >= 0 ? 'text-emerald-600' : 'text-rose-600';

        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="py-3 px-4 font-bold text-slate-800">
              ลอตที่ ${lotNumber}
            </td>
            <td class="py-3 px-4 text-slate-600">${startStr} - ${endStr}</td>
            <td class="py-3 px-4 text-right font-mono font-bold text-blue-600">฿${income.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
            <td class="py-3 px-4 text-right font-mono font-bold text-rose-600">฿${expense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
            <td class="py-3 px-4 text-right font-mono font-extrabold ${profitClass}">
              ${profit >= 0 ? '+' : ''}฿${profit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}
            </td>
            <td class="py-3 px-4 text-center">
              <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                ปิดรอบแล้ว
              </span>
            </td>
          </tr>
        `;
      }).join('');
    }

    document.getElementById('hist-tfoot-income').innerText = `฿${sumIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    document.getElementById('hist-tfoot-expense').innerText = `฿${sumExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    const tfootProfitEl = document.getElementById('hist-tfoot-profit');
    tfootProfitEl.innerText = `${sumProfit >= 0 ? '+' : ''}฿${sumProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    tfootProfitEl.className = `py-3 px-4 text-right font-mono font-extrabold ${sumProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;
  }

  // Render On-Screen Table 2: Daily Transaction Ledger (ตารางแบบที่ 2: แจกแจงรายวัน)
  const dailyFilterEl = document.getElementById('hist-daily-filter');
  await renderOnScreenDailyLedger(dailyFilterEl ? dailyFilterEl.value : 'all');

  let totalLifetimeProfit = 0;

  if (closedLots.length === 0) {
    listContainer.innerHTML = `
      <div class="col-span-full text-center py-12 text-slate-400 bg-white rounded-3xl p-6 border border-slate-200">
        <i class="fa-solid fa-box-archive text-4xl text-slate-300 mb-3 block"></i>
        <p class="text-xs font-semibold">ยังไม่มีประวัติลอตที่ปิดรอบ</p>
        <p class="text-[11px] text-slate-400 mt-1">เมื่อคุณกด "ปิดลอตการขาย" ในหน้าแรก ประวัติจะมาแสดงที่นี่</p>
      </div>
    `;
    totalProfitEl.innerText = '฿0.00';
    return;
  }

  // Map lot ID to its chronological Lot Number (ลอตที่ 1, 2, ...)
  const lotNumMap = {};
  chronologicalClosed.forEach((l, i) => {
    lotNumMap[l.id] = i + 1;
  });

  listContainer.innerHTML = closedLots.map((lot) => {
    const lotNumber = lotNumMap[lot.id] || '-';
    const cost = parseFloat(lot.cost) || 5000;
    const collected = parseFloat(lot.total_collected) || 0;
    const profit = collected - cost;
    totalLifetimeProfit += profit;

    const startObj = new Date(lot.created_at);
    const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
    const durationDays = Math.max(1, Math.round((endObj - startObj) / (1000 * 60 * 60 * 24)));

    const startDate = startObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    const endDate = lot.closed_at 
      ? endObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
      : '-';

    const isProfitable = profit >= 0;

    return `
      <div class="bg-white rounded-3xl p-5 shadow-sm border border-slate-200 hover:border-slate-300 hover:shadow-md transition space-y-3 flex flex-col justify-between">
        <div class="space-y-3">
          <!-- Top Row: Lot Number & Date Range -->
          <div class="flex items-center justify-between text-xs border-b border-slate-100 pb-2.5">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-slate-800 text-xs sm:text-sm">ลอตที่ ${lotNumber}</span>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">${durationDays} วัน</span>
            </div>
            <span class="text-slate-400 text-[11px]">${startDate} - ${endDate}</span>
          </div>

          <!-- Metrics Grid -->
          <div class="grid grid-cols-3 gap-2 text-center py-1">
            <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <span class="text-[10px] text-slate-400 block">รายรับ</span>
              <span class="font-bold text-xs sm:text-sm text-blue-600 font-mono">฿${collected.toLocaleString('th-TH')}</span>
            </div>
            <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <span class="text-[10px] text-slate-400 block">รายจ่าย</span>
              <span class="font-bold text-xs sm:text-sm text-rose-600 font-mono">฿${cost.toLocaleString('th-TH')}</span>
            </div>
            <div class="p-2.5 rounded-xl border ${isProfitable ? 'bg-emerald-50 text-emerald-800 border-emerald-100' : 'bg-rose-50 text-rose-800 border-rose-100'}">
              <span class="text-[10px] block opacity-80">กำไรสุทธิ</span>
              <span class="font-black text-xs sm:text-sm font-mono">
                ${isProfitable ? '+' : ''}฿${profit.toLocaleString('th-TH')}
              </span>
            </div>
          </div>
        </div>

        <!-- Bottom Action Row -->
        <div class="text-[11px] text-slate-400 flex items-center justify-between pt-2 border-t border-slate-100">
          <span class="font-medium ${isProfitable ? 'text-emerald-600' : 'text-slate-500'}">
            ${isProfitable ? '✓ ได้กำไรตามเป้า' : 'ของเหลือยกไปลอตใหม่'}
          </span>
          <button onclick="openA4ReportModal('${lot.id}')" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 font-semibold transition flex items-center gap-1">
            <i class="fa-solid fa-list-ul text-[10px]"></i> ดูรายวันลอตนี้
          </button>
        </div>
      </div>
    `;
  }).join('');

  totalProfitEl.innerText = `${totalLifetimeProfit >= 0 ? '+' : ''}฿${totalLifetimeProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
}

// ========================================================
// 4. Modals: Edit Cost/Float, Edit/Delete Sale, Close Lot, Config
// ========================================================
function openEditCostModal() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;
  document.getElementById('edit-lot-cost-input').value = parseLotCost(activeLot.cost, 5000);
  document.getElementById('edit-lot-float-input').value = activeLot.float_money !== undefined ? roundMoney(activeLot.float_money) : 500;
  document.getElementById('edit-cost-modal').classList.remove('hidden');
}

async function handleSaveCostAndFloat(e) {
  e.preventDefault();
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;

  const newCost = roundMoney(document.getElementById('edit-lot-cost-input').value);
  const newFloat = roundMoney(document.getElementById('edit-lot-float-input').value);

  if (isNaN(newCost) || newCost <= 0) {
    showToast('กรุณาระบุต้นทุนที่มากกว่า 0 บาท', 'error');
    return;
  }

  // Keep saved lot order cost in sync if one exists
  const existingOrder = getLotOrderData(activeLot.id);
  let updatedOrderPayload = null;
  if (existingOrder) {
    updatedOrderPayload = saveLotOrderData(activeLot.id, {
      ...existingOrder,
      totalCost: newCost,
      totalProfit: roundMoney((existingOrder.totalRevenue || 0) - newCost)
    });
  }

  const ok = await updateLotCostAndFloatDB(
    activeLot.id,
    newCost,
    isNaN(newFloat) ? 0 : newFloat,
    updatedOrderPayload ? { order_data: updatedOrderPayload } : null
  );
  closeModal('edit-cost-modal');
  if (ok) {
    showToast('บันทึกการแก้ไขต้นทุนและเงินทอนตั้งต้นเรียบร้อยแล้ว', 'success');
  } else {
    showToast('บันทึกในเครื่องแล้ว (รอซิงค์เมื่อออนไลน์)', 'warning');
  }
  await loadActiveLotData();
  renderActiveLotForecastCard();
  updateInputField();
}

function openEditSaleModal(saleId) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const sale = currentLotSales.find(s => s.id === saleId);
  if (!sale) return;

  document.getElementById('edit-sale-id').value = sale.id;
  document.getElementById('edit-sale-amount').value = roundMoney(sale.amount || 0);
  document.getElementById('edit-sale-shift').value = sale.shift || 'lunch';
  document.getElementById('edit-sale-note').value = sale.note || '';

  const d = new Date(sale.created_at);
  document.getElementById('edit-sale-timestamp').innerText = `บันทึกเมื่อ: ${d.toLocaleDateString('th-TH')} เวลา ${d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.`;

  document.getElementById('edit-sale-modal').classList.remove('hidden');
}

async function handleUpdateDailySale(e) {
  e.preventDefault();
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;

  const saleId = document.getElementById('edit-sale-id').value;
  const rawVal = document.getElementById('edit-sale-amount').value;
  const newAmt = rawVal === '' ? NaN : roundMoney(rawVal);
  const newShift = document.getElementById('edit-sale-shift').value;
  const newNote = document.getElementById('edit-sale-note').value.trim();

  if (isNaN(newAmt) || newAmt < 0 || (newAmt === 0 && !newNote)) {
    showToast('กรุณาระบุยอดขายมากกว่า 0 บาท (หรือใส่ 0 บาทพร้อมระบุหมายเหตุสำหรับวันงดขาย)', 'error');
    return;
  }

  await updateDailySaleDB(saleId, activeLot.id, newAmt, newShift, newNote);
  closeModal('edit-sale-modal');
  showToast('แก้ไขข้อมูลยอดขายเรียบร้อยแล้ว', 'success');
  await loadActiveLotData();
}

async function handleDeleteDailySale() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;
  const saleId = document.getElementById('edit-sale-id').value;
  if (!saleId) return;

  const confirmed = await showConfirmDialog({
    title: 'ยืนยันการลบรายการขาย?',
    message: 'ระบบจะคำนวณยอดขายสะสมและกำไรคงเหลือใหม่ทันที',
    confirmText: 'ยืนยันการลบ',
    cancelText: 'ยกเลิก',
    type: 'danger',
    icon: 'fa-trash-can'
  });

  if (!confirmed) return;

  await deleteDailySaleDB(saleId, activeLot.id);
  closeModal('edit-sale-modal');
  showToast('ลบรายการยอดขายและคำนวณยอดสะสมใหม่เรียบร้อย', 'info');
  await loadActiveLotData();
}

function toggleCloseLotWithdrawFields() {
  const chk = document.getElementById('close-lot-withdraw-chk');
  const fields = document.getElementById('close-lot-withdraw-fields');
  if (!chk || !fields) return;

  if (chk.checked) {
    fields.classList.remove('hidden');
    const cost = parseLotCost(activeLot?.cost, 5000);
    const collected = roundMoney(activeLot?.total_collected || 0);
    const profit = roundMoney(Math.max(0, collected - cost));
    const amountInput = document.getElementById('close-lot-withdraw-amount');
    if (amountInput && (!amountInput.value || parseFloat(amountInput.value) <= 0)) {
      amountInput.value = profit;
    }
  } else {
    fields.classList.add('hidden');
  }
}

function confirmCloseLot() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;

  const cost = parseLotCost(activeLot.cost, 5000);
  const collected = roundMoney(activeLot.total_collected || 0);
  const profit = roundMoney(collected - cost);

  document.getElementById('modal-close-cost').innerText = `฿${cost.toLocaleString('th-TH')}`;
  document.getElementById('modal-close-collected').innerText = `฿${collected.toLocaleString('th-TH')}`;
  
  const profitEl = document.getElementById('modal-close-profit');
  profitEl.innerText = `${profit >= 0 ? '+' : ''}฿${profit.toLocaleString('th-TH')}`;
  profitEl.className = profit >= 0 ? 'font-mono text-emerald-600 font-bold' : 'font-mono text-rose-600 font-bold';

  const nextCostInput = document.getElementById('close-lot-next-cost');
  if (nextCostInput) {
    nextCostInput.value = cost;
  }

  // Handle optional immediate withdrawal section
  const withdrawSec = document.getElementById('close-lot-withdraw-section');
  const withdrawChk = document.getElementById('close-lot-withdraw-chk');
  const withdrawFields = document.getElementById('close-lot-withdraw-fields');
  const withdrawAmountInput = document.getElementById('close-lot-withdraw-amount');

  if (withdrawSec) {
    if (profit > 0) {
      withdrawSec.classList.remove('hidden');
      if (withdrawChk) withdrawChk.checked = false;
      if (withdrawFields) withdrawFields.classList.add('hidden');
      if (withdrawAmountInput) {
        withdrawAmountInput.value = profit;
        withdrawAmountInput.max = profit;
      }
    } else {
      withdrawSec.classList.add('hidden');
      if (withdrawChk) withdrawChk.checked = false;
      if (withdrawFields) withdrawFields.classList.add('hidden');
    }
  }

  document.getElementById('close-lot-modal').classList.remove('hidden');
}

function generateNextPvNumber(dateIso, withdrawalsList = []) {
  const ym = (dateIso || getLocalDateISO()).replace(/-/g, '').slice(0, 6);
  const prefix = `PV-${ym}-`;
  let maxSeq = 0;
  (withdrawalsList || []).forEach(w => {
    const pv = String(w.pv_number || '');
    if (pv.startsWith('PV-')) {
      const parts = pv.split('-');
      const seq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  const nextSeq = Math.max(maxSeq + 1, (withdrawalsList ? withdrawalsList.length : 0) + 1);
  return `${prefix}${String(nextSeq).padStart(3, '0')}`;
}

async function executeCloseLot() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) return;

  const cost = parseLotCost(activeLot.cost, 5000);
  const collected = roundMoney(activeLot.total_collected || 0);
  const profit = roundMoney(collected - cost);

  const nextCostInput = document.getElementById('close-lot-next-cost');
  const nextLotCost = nextCostInput && nextCostInput.value !== '' ? parseLotCost(nextCostInput.value, cost) : cost;

  const withdrawChk = document.getElementById('close-lot-withdraw-chk');
  let withdrawData = null;

  if (withdrawChk && withdrawChk.checked && profit > 0) {
    const amountVal = roundMoney(document.getElementById('close-lot-withdraw-amount')?.value || 0);
    if (amountVal <= 0) {
      alert('กรุณาระบุจำนวนเงินที่ต้องการเบิกมากกว่า 0 บาท หรือยกเลิกการเลือกเบิกเงิน');
      return;
    }
    if (amountVal > profit) {
      alert(`จำนวนเงินที่เบิก (฿${amountVal.toLocaleString()}) เกินกว่ากำไรสุทธิงวดนี้ (฿${profit.toLocaleString()})`);
      return;
    }

    const category = document.getElementById('close-lot-withdraw-category')?.value || 'กิจกรรมโรงเรียน';
    const purpose = document.getElementById('close-lot-withdraw-purpose')?.value.trim() || 'เบิกเงินกำไรเมื่อปิดลอตการขาย';
    const recipient = document.getElementById('close-lot-withdraw-recipient')?.value.trim() || 'ผู้รับผิดชอบโครงการ';

    withdrawData = {
      amount: amountVal,
      category,
      purpose,
      recipient,
      approver: 'ผู้อำนวยการโรงเรียน'
    };
  }

  const btnAction = document.getElementById('btn-confirm-close-action');
  btnAction.disabled = true;
  btnAction.innerText = 'กำลังปิดลอตและสร้างลอตใหม่...';

  const closedLotId = activeLot.id;
  const newLot = await closeActiveLotAndStartNew(closedLotId, nextLotCost);

  btnAction.disabled = false;
  btnAction.innerText = 'ยืนยันปิดลอต & เปิดใหม่';
  closeModal('close-lot-modal');

  if (newLot) {
    // If user chose to withdraw profit on close
    if (withdrawData) {
      const allWithdrawals = await fetchWithdrawals();
      const todayIso = getLocalDateISO();
      const pvNo = generateNextPvNumber(todayIso, allWithdrawals);

      const newWithdrawal = {
        id: generateUUID(),
        pv_number: pvNo,
        date: todayIso,
        amount: withdrawData.amount,
        category: withdrawData.category,
        purpose: withdrawData.purpose,
        recipient: withdrawData.recipient,
        approver: withdrawData.approver,
        lot_id: closedLotId,
        created_at: new Date().toISOString()
      };

      await insertWithdrawal(newWithdrawal);
      showToast(`ปิดลอตสำเร็จ! และบันทึกเบิกกำไร ฿${withdrawData.amount.toLocaleString()} เรียบร้อยแล้ว`, 'success');
    } else {
      showToast('ปิดลอตเดิมสำเร็จ! เปิดลอตใหม่เรียบร้อยแล้ว กำไรถูกสะสมเข้ากระปุกกองทุน', 'success');
    }

    await loadActiveLotData();
  }
}

// ========================================================
// 4.5 Official A4 Income-Expense Ledger Report & Excel Export
// ========================================================
async function buildLedgerData(scope) {
  const closed = await fetchClosedLotsWithDetails();
  if (!activeLot) activeLot = await fetchActiveLot();

  // Chronological order (oldest = ลอตที่ 1)
  const chronologicalClosed = [...closed].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const allLotsChronological = activeLot ? [...chronologicalClosed, activeLot] : chronologicalClosed;

  // MODE 1 (DEFAULT): สรุปบัญชีรายรับ-รายจ่าย รายลอต เฉพาะลอตที่ปิดรอบแล้ว (ไม่รวมลอตที่กำลังขาย)
  if (scope === 'lot_summary') {
    const lotRows = [];
    let totalIncome = 0;
    let totalExpense = 0;

    chronologicalClosed.forEach((lot, idx) => {
      const lotNumber = idx + 1;
      const income = parseFloat(lot.total_collected) || 0;
      const expense = parseFloat(lot.cost) || 5000;
      const profit = income - expense;

      totalIncome += income;
      totalExpense += expense;

      const startObj = new Date(lot.created_at);
      const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
      const startStr = startObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const endStr = lot.closed_at
        ? endObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '-';

      lotRows.push({
        lotTitle: `ลอตที่ ${lotNumber}`,
        dateRange: `${startStr} - ${endStr}`,
        income,
        expense,
        profit,
        statusLabel: 'ปิดรอบแล้ว'
      });
    });

    return {
      mode: 'lot_summary',
      rows: lotRows,
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense
    };
  }

  // MODE 2: แจกแจงรายวัน (ค่าเริ่มต้น 'all' จะแสดงเฉพาะลอตที่ปิดรอบแล้ว ส่วน 'active' แสดงเฉพาะลอตปัจจุบัน)
  let targetLots = [];
  if (scope === 'active' && activeLot) {
    targetLots = [activeLot];
  } else if (scope === 'all' || scope === 'closed') {
    targetLots = chronologicalClosed;
  } else {
    const found = allLotsChronological.find(l => l.id === scope);
    if (found) targetLots = [found];
  }

  const rows = [];
  let totalIncome = 0;
  let totalExpense = 0;
  let runningBalance = 0;

  for (const lot of targetLots) {
    const lotIdx = allLotsChronological.findIndex(l => l.id === lot.id);
    const lotNum = lotIdx !== -1 ? lotIdx + 1 : '-';
    const cost = parseFloat(lot.cost) || 5000;
    const lotDate = new Date(lot.created_at);

    totalExpense += cost;
    runningBalance -= cost;
    rows.push({
      dateStr: lotDate.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      description: `ซื้อไอศกรีมเหมาลอต (ลอตที่ ${lotNum})`,
      shiftLabel: '-',
      income: 0,
      expense: cost,
      balance: runningBalance,
      note: lot.status === 'active' ? 'ลอตปัจจุบัน' : 'ปิดรอบแล้ว'
    });

    const lotSales = await fetchSalesForLot(lot.id);
    const sortedSales = [...lotSales].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    for (const s of sortedSales) {
      const sDate = new Date(s.created_at);
      const amt = parseFloat(s.amount) || 0;
      totalIncome += amt;
      runningBalance += amt;

      const shiftLabel = amt === 0 ? 'งดขาย' : (s.shift === 'afternoon' ? 'พักบ่าย' : 'พักเที่ยง');
      rows.push({
        dateStr: sDate.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        description: amt === 0 ? `งดขายไอศกรีม (ลอตที่ ${lotNum})` : `รายรับขายไอศกรีม (ลอตที่ ${lotNum})`,
        shiftLabel,
        income: amt,
        expense: 0,
        balance: runningBalance,
        note: s.note || ''
      });
    }
  }

  return { mode: 'daily_detail', rows, totalIncome, totalExpense, netProfit: totalIncome - totalExpense };
}

async function renderOnScreenDailyLedger(filterScope = 'all') {
  const dailyTbody = document.getElementById('hist-daily-ledger-tbody');
  if (!dailyTbody) return;

  const { rows, totalIncome, totalExpense, netProfit } = await buildLedgerData(filterScope === 'active' ? 'active' : 'all');

  if (rows.length === 0) {
    dailyTbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-400">ยังไม่มีรายการบันทึกบัญชีรายวัน</td></tr>';
  } else {
    dailyTbody.innerHTML = rows.map(r => `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-2.5 px-3 font-mono text-slate-600">${r.dateStr}</td>
        <td class="py-2.5 px-3 font-medium text-slate-800">${escapeHtml(r.description)}</td>
        <td class="py-2.5 px-3 text-center">
          ${r.shiftLabel === '-' ? '<span class="text-slate-400">-</span>' : `<span class="px-2 py-0.5 rounded text-[10px] font-bold ${r.shiftLabel === 'พักบ่าย' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}">${r.shiftLabel}</span>`}
        </td>
        <td class="py-2.5 px-3 text-right font-mono font-bold text-blue-600">${r.income > 0 ? `฿${r.income.toLocaleString('th-TH', { minimumFractionDigits: 2 })}` : '-'}</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold text-rose-600">${r.expense > 0 ? `฿${r.expense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}` : '-'}</td>
        <td class="py-2.5 px-3 text-right font-mono font-bold ${r.balance >= 0 ? 'text-emerald-600' : 'text-slate-700'}">${r.balance >= 0 ? '+' : ''}฿${r.balance.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-3 text-slate-500">${escapeHtml(r.note)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('hist-daily-tfoot-income').innerText = `฿${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  document.getElementById('hist-daily-tfoot-expense').innerText = `฿${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  const balEl = document.getElementById('hist-daily-tfoot-balance');
  balEl.innerText = `${netProfit >= 0 ? '+' : ''}฿${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  balEl.className = `py-3 px-3 text-right font-mono font-extrabold ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;
}

async function openA4ReportModal(scope = 'both') {
  currentReportScope = scope;
  const selectEl = document.getElementById('report-scope-select');
  if (selectEl) {
    if (['both', 'lot_summary', 'active', 'all'].includes(scope)) {
      selectEl.value = scope;
    }
  }

  await renderA4ReportContent(scope);
  document.getElementById('a4-report-modal').classList.remove('hidden');
}

async function changeA4ReportScope(newScope) {
  currentReportScope = newScope;
  await renderA4ReportContent(newScope);
}

function buildLotSummaryHtmlParts(rows, totalIncome, totalExpense, netProfit) {
  const theadHtml = `
    <tr class="bg-slate-800 text-white text-xs">
      <th style="width: 14%;" class="px-3 py-2.5 text-center">ลอตการขาย</th>
      <th style="width: 28%;" class="px-3 py-2.5 text-left">ช่วงวันที่จำหน่าย</th>
      <th style="width: 15%;" class="px-3 py-2.5 text-right">รายรับ (บาท)</th>
      <th style="width: 15%;" class="px-3 py-2.5 text-right">รายจ่าย (บาท)</th>
      <th style="width: 15%;" class="px-3 py-2.5 text-right">กำไรสุทธิ (บาท)</th>
      <th style="width: 13%;" class="px-3 py-2.5 text-center">สถานะ</th>
    </tr>
  `;

  const tbodyHtml = rows.length === 0
    ? '<tr><td colspan="6" class="px-3 py-6 text-center text-slate-400">ยังไม่มีข้อมูลลอตการขายที่ปิดรอบแล้ว</td></tr>'
    : rows.map(r => `
        <tr class="even:bg-slate-50/70">
          <td class="px-3 py-2.5 text-center font-bold text-slate-900">${r.lotTitle}</td>
          <td class="px-3 py-2.5 text-slate-700">${r.dateRange}</td>
          <td class="px-3 py-2.5 text-right font-mono font-semibold text-blue-700">${r.income.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-3 py-2.5 text-right font-mono font-semibold text-rose-700">${r.expense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-3 py-2.5 text-right font-mono font-bold ${r.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${r.profit >= 0 ? '+' : ''}${r.profit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-3 py-2.5 text-center font-medium text-slate-700">${r.statusLabel}</td>
        </tr>
      `).join('');

  const tfootHtml = `
    <tr class="bg-slate-100 font-extrabold text-slate-900 text-xs">
      <td colspan="2" class="px-3 py-3 text-right">รวมลอตที่ปิดแล้วทั้งสิ้น (Total)</td>
      <td class="px-3 py-3 text-right font-mono text-blue-700">${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-3 py-3 text-right font-mono text-rose-700">${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-3 py-3 text-right font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-3 py-3"></td>
    </tr>
  `;

  return { theadHtml, tbodyHtml, tfootHtml };
}

function buildDailyDetailHtmlParts(rows, totalIncome, totalExpense, netProfit) {
  const theadHtml = `
    <tr class="bg-slate-800 text-white text-xs">
      <th style="width: 13%;" class="px-2.5 py-2.5 text-center">วัน/เดือน/ปี</th>
      <th style="width: 24%;" class="px-3 py-2.5 text-left">รายการบัญชี</th>
      <th style="width: 10%;" class="px-2 py-2.5 text-center">กะเวลา</th>
      <th style="width: 13%;" class="px-2.5 py-2.5 text-right">รายรับ (บาท)</th>
      <th style="width: 13%;" class="px-2.5 py-2.5 text-right">รายจ่าย (บาท)</th>
      <th style="width: 14%;" class="px-2.5 py-2.5 text-right">คงเหลือสะสม</th>
      <th style="width: 13%;" class="px-2.5 py-2.5 text-left">หมายเหตุ</th>
    </tr>
  `;

  const tbodyHtml = rows.length === 0
    ? '<tr><td colspan="7" class="px-3 py-6 text-center text-slate-400">ยังไม่มีรายการบันทึกบัญชี</td></tr>'
    : rows.map(r => `
        <tr class="even:bg-slate-50/70">
          <td class="px-2.5 py-2 text-center font-mono text-[11px] text-slate-700">${r.dateStr}</td>
          <td class="px-3 py-2 font-medium text-slate-800">${escapeHtml(r.description)}</td>
          <td class="px-2 py-2 text-center text-slate-700">${r.shiftLabel}</td>
          <td class="px-2.5 py-2 text-right font-mono font-semibold text-blue-700">${r.income > 0 ? r.income.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
          <td class="px-2.5 py-2 text-right font-mono font-semibold text-rose-700">${r.expense > 0 ? r.expense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</td>
          <td class="px-2.5 py-2 text-right font-mono font-bold ${r.balance >= 0 ? 'text-emerald-700' : 'text-slate-700'}">${r.balance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td class="px-2.5 py-2 text-slate-600">${escapeHtml(r.note || '-')}</td>
        </tr>
      `).join('');

  const tfootHtml = `
    <tr class="bg-slate-100 font-extrabold text-slate-900 text-xs">
      <td colspan="3" class="px-3 py-3 text-right">รวมทั้งสิ้น (Total)</td>
      <td class="px-2.5 py-3 text-right font-mono text-blue-700">${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-2.5 py-3 text-right font-mono text-rose-700">${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-2.5 py-3 text-right font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="px-2.5 py-3"></td>
    </tr>
  `;

  return { theadHtml, tbodyHtml, tfootHtml };
}

async function renderA4ReportContent(scope) {
  const nowStr = new Date().toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  document.getElementById('a4-report-printed-date').innerText = `วันที่ออกรายงาน: ${nowStr} น.`;

  const table1Title = document.getElementById('a4-table1-title');
  const secondTableContainer = document.getElementById('a4-second-table-container');

  if (scope === 'both') {
    const lotData = await buildLedgerData('lot_summary');
    const dailyData = await buildLedgerData('all');

    document.getElementById('a4-report-subtitle').innerText = 'รายงานสรุปบัญชีรายรับ - รายจ่าย รายลอต และแจกแจงรายการรายวัน';
    document.getElementById('a4-total-income').innerText = `฿${lotData.totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    document.getElementById('a4-total-expense').innerText = `฿${lotData.totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

    const netEl = document.getElementById('a4-net-profit');
    netEl.innerText = `${lotData.netProfit >= 0 ? '+' : ''}฿${lotData.netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    netEl.className = `text-base sm:text-lg font-extrabold font-mono ${lotData.netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;

    table1Title.innerText = '1. ตารางแบบที่ 1: สรุปบัญชีรายรับ - รายจ่าย รายลอต (Lot Summary Ledger)';
    const parts1 = buildLotSummaryHtmlParts(lotData.rows, lotData.totalIncome, lotData.totalExpense, lotData.netProfit);
    document.getElementById('a4-ledger-thead').innerHTML = parts1.theadHtml;
    document.getElementById('a4-ledger-tbody').innerHTML = parts1.tbodyHtml;
    document.getElementById('a4-ledger-tfoot').innerHTML = parts1.tfootHtml;

    secondTableContainer.classList.remove('hidden');
    const parts2 = buildDailyDetailHtmlParts(dailyData.rows, dailyData.totalIncome, dailyData.totalExpense, dailyData.netProfit);
    document.getElementById('a4-ledger2-thead').innerHTML = parts2.theadHtml;
    document.getElementById('a4-ledger2-tbody').innerHTML = parts2.tbodyHtml;
    document.getElementById('a4-ledger2-tfoot').innerHTML = parts2.tfootHtml;
    return;
  }

  secondTableContainer.classList.add('hidden');
  const { mode, rows, totalIncome, totalExpense, netProfit } = await buildLedgerData(scope);

  document.getElementById('a4-report-subtitle').innerText = mode === 'lot_summary'
    ? 'ตารางแบบที่ 1: สรุปบัญชีรายรับ - รายจ่าย แยกตามลอตการจำหน่าย (ไม่รวมรายการย่อยรายวัน)'
    : 'ตารางแบบที่ 2: รายงานแจกแจงรายการรายรับ - รายจ่าย รายวัน';

  document.getElementById('a4-total-income').innerText = `฿${totalIncome.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  document.getElementById('a4-total-expense').innerText = `฿${totalExpense.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  
  const netEl = document.getElementById('a4-net-profit');
  netEl.innerText = `${netProfit >= 0 ? '+' : ''}฿${netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
  netEl.className = `text-base sm:text-lg font-extrabold font-mono ${netProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`;

  if (mode === 'lot_summary') {
    table1Title.innerText = 'ตารางสรุปบัญชีรายรับ - รายจ่าย รายลอต (Lot Summary Ledger)';
    const parts = buildLotSummaryHtmlParts(rows, totalIncome, totalExpense, netProfit);
    document.getElementById('a4-ledger-thead').innerHTML = parts.theadHtml;
    document.getElementById('a4-ledger-tbody').innerHTML = parts.tbodyHtml;
    document.getElementById('a4-ledger-tfoot').innerHTML = parts.tfootHtml;
  } else {
    table1Title.innerText = 'ตารางบัญชีรายรับ - รายจ่าย แจกแจงรายวัน (Daily Transaction Ledger)';
    const parts = buildDailyDetailHtmlParts(rows, totalIncome, totalExpense, netProfit);
    document.getElementById('a4-ledger-thead').innerHTML = parts.theadHtml;
    document.getElementById('a4-ledger-tbody').innerHTML = parts.tbodyHtml;
    document.getElementById('a4-ledger-tfoot').innerHTML = parts.tfootHtml;
  }
}

async function exportCurrentReportToExcel() {
  await exportLedgerToExcel(currentReportScope);
}

async function exportLedgerToExcel() {
  if (!window.XLSX) {
    showToast('ไม่พบไลบรารีสร้าง Excel กรุณาใช้ปุ่มพิมพ์รายงาน A4 แทน', 'warning');
    return;
  }

  // Always export BOTH sheets (Sheet 1: สรุปรายลอต, Sheet 2: แจกแจงรายวัน) into the Excel file!
  const lotData = await buildLedgerData('lot_summary');
  const dailyData = await buildLedgerData('all');

  // Sheet 1: สรุปรายลอต (Lot Summary)
  const sheet1Data = [
    ['ตารางแบบที่ 1: สรุปบัญชีรายรับ - รายจ่าย รายลอต (ไม่รวมรายวัน)'],
    [`วันที่ส่งออกข้อมูล: ${new Date().toLocaleDateString('th-TH')}`],
    [],
    ['ลอตการขาย', 'ช่วงวันที่จำหน่าย', 'รายรับ (บาท)', 'รายจ่าย / ต้นทุน (บาท)', 'กำไรสุทธิ (บาท)', 'สถานะ']
  ];
  lotData.rows.forEach(r => {
    sheet1Data.push([r.lotTitle, r.dateRange, r.income, r.expense, r.profit, r.statusLabel]);
  });
  sheet1Data.push([]);
  sheet1Data.push(['', 'รวมลอตที่ปิดแล้วทั้งสิ้น (Total)', lotData.totalIncome, lotData.totalExpense, lotData.netProfit, lotData.netProfit >= 0 ? 'กำไรสุทธิ' : 'ขาดทุน']);

  const ws1 = window.XLSX.utils.aoa_to_sheet(sheet1Data);
  ws1['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 16 }];

  // Sheet 2: แจกแจงรายวัน (Daily Ledger)
  const sheet2Data = [
    ['ตารางแบบที่ 2: บัญชีรายรับ - รายจ่าย แจกแจงรายวัน'],
    [`วันที่ส่งออกข้อมูล: ${new Date().toLocaleDateString('th-TH')}`],
    [],
    ['วัน/เดือน/ปี', 'รายการ (รายละเอียดบัญชี)', 'กะเวลา', 'รายรับ (บาท)', 'รายจ่าย (บาท)', 'คงเหลือสะสม (บาท)', 'หมายเหตุ']
  ];
  dailyData.rows.forEach(r => {
    sheet2Data.push([r.dateStr, r.description, r.shiftLabel, r.income > 0 ? r.income : '', r.expense > 0 ? r.expense : '', r.balance, r.note]);
  });
  sheet2Data.push([]);
  sheet2Data.push(['', 'รวมทั้งสิ้น (Total)', '', dailyData.totalIncome, dailyData.totalExpense, dailyData.netProfit, '']);

  const ws2 = window.XLSX.utils.aoa_to_sheet(sheet2Data);
  ws2['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 24 }];

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws1, '1_สรุปรายลอต');
  window.XLSX.utils.book_append_sheet(wb, ws2, '2_บัญชีแจกแจงรายวัน');

  const fileName = `รายงานบัญชีขายไอศกรีม_ครบทั้ง2ตาราง_${new Date().toISOString().slice(0, 10)}.xlsx`;
  window.XLSX.writeFile(wb, fileName);
  showToast('ดาวน์โหลดไฟล์ Excel (ครบทั้ง 2 ตาราง: สรุปรายลอต + แจกแจงรายวัน) สำเร็จแล้ว!', 'success');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openConfigModal() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const sbUrl = localStorage.getItem(STORAGE_KEYS.SUPABASE_URL) || DEFAULT_SUPABASE.URL;
  const sbKey = localStorage.getItem(STORAGE_KEYS.SUPABASE_KEY) || DEFAULT_SUPABASE.KEY;

  document.getElementById('cfg-supabase-url').value = sbUrl;
  document.getElementById('cfg-supabase-key').value = sbKey;
  document.getElementById('config-modal').classList.remove('hidden');
}

function getSupabaseUpgradeSQL() {
  return `-- SQL อัปเกรดฐานข้อมูล Wall's POS & STORE (คัดลอกไปวางใน Supabase SQL Editor แล้วกด Run)
alter table public.lots add column if not exists float_money numeric not null default 500;
alter table public.lots add column if not exists order_data jsonb default null;
alter table public.lots add column if not exists lot_note text default '';

create table if not exists public.products (
    id text primary key,
    name text not null,
    category text not null default 'แท่ง',
    pieces_per_box integer not null default 24,
    cost_per_piece numeric not null default 0,
    box_cost numeric null,
    retail_price numeric not null default 0,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table public.products enable row level security;
drop policy if exists "Allow all operations for anon on products" on public.products;
create policy "Allow all operations for anon on products" on public.products for all to anon using (true) with check (true);

create table if not exists public.withdrawals (
    id uuid primary key default gen_random_uuid(),
    pv_number text not null default '',
    date text not null,
    amount numeric not null check (amount > 0),
    category text not null default 'กิจกรรมโรงเรียน',
    purpose text not null default '',
    recipient text not null default '',
    approver text not null default 'ผู้อำนวยการโรงเรียน',
    lot_id uuid null references public.lots(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_withdrawals_created_at on public.withdrawals(created_at desc);
alter table public.withdrawals enable row level security;
drop policy if exists "Allow all operations for anon on withdrawals" on public.withdrawals;
create policy "Allow all operations for anon on withdrawals" on public.withdrawals for all to anon using (true) with check (true);

create table if not exists public.director_visits (
    id uuid primary key default gen_random_uuid(),
    visited_at timestamp with time zone default timezone('utc'::text, now()) not null,
    last_active_at timestamp with time zone default timezone('utc'::text, now()) not null,
    device_label text not null default 'ไม่ระบุอุปกรณ์',
    viewed_tabs text not null default 'สมุดบัญชีกำไร',
    user_agent text default ''
);
create index if not exists idx_director_visits_visited_at on public.director_visits(visited_at desc);
alter table public.director_visits enable row level security;
drop policy if exists "Allow all operations for anon on director_visits" on public.director_visits;
create policy "Allow all operations for anon on director_visits" on public.director_visits for all to anon using (true) with check (true);`;
}

function copySupabaseUpgradeSQL() {
  const sql = getSupabaseUpgradeSQL();
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(sql).then(() => {
      showToast('คัดลอกคำสั่ง SQL เรียบร้อย! นำไปวางใน Supabase SQL Editor แล้วกด Run ได้เลยครับ', 'success');
    }).catch(() => {
      prompt('คัดลอกคำสั่ง SQL ด้านล่างไปวางใน Supabase SQL Editor:', sql);
    });
  } else {
    prompt('คัดลอกคำสั่ง SQL ด้านล่างไปวางใน Supabase SQL Editor:', sql);
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

async function handleSaveConfig(e) {
  e.preventDefault();
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const url = document.getElementById('cfg-supabase-url').value.trim();
  const key = document.getElementById('cfg-supabase-key').value.trim();

  if (!url || !key) {
    showToast('กรุณากรอกทั้ง URL และ Key ให้ครบถ้วน', 'error');
    return;
  }

  localStorage.setItem(STORAGE_KEYS.SUPABASE_URL, url);
  localStorage.setItem(STORAGE_KEYS.SUPABASE_KEY, key);
  localStorage.removeItem(STORAGE_KEYS.STORAGE_MODE);

  closeModal('config-modal');
  showToast('บันทึกการตั้งค่าแล้ว กำลังเชื่อมต่อ Supabase...', 'info');

  await setupDatabaseClient();
  await loadActiveLotData();
}

function useDemoMode() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, 'local');
  closeModal('config-modal');
  showToast('สลับมาใช้โหมดจัดเก็บข้อมูลในเครื่อง (Local Mode) เรียบร้อย', 'info');
  setupDatabaseClient();
  loadActiveLotData();
}

function clearLocalDataAndReset() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!confirm('ยืนยันล้างข้อมูลแคชทดสอบในเครื่องและเริ่มนับใหม่?')) return;
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOTS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_SALES);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_WITHDRAWALS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOT_ORDERS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOT_NOTES);
  localStorage.removeItem(STORAGE_KEYS.PENDING_SALES_QUEUE);
  closeModal('config-modal');
  showToast('ล้างแคชทดสอบเรียบร้อย กำลังรีเฟรชระบบ...', 'success');
  setTimeout(() => window.location.reload(), 800);
}

async function triggerFactoryReset() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const confirmMsg = "⚠️ คำเตือน: คุณต้องการ 'รีเซ็ตระบบทั้งหมดเพื่อเริ่มใช้งานจริง (Factory Reset)' ใช่หรือไม่?\n\n- ประวัติยอดขายรายวันทั้งหมดจะถูกลบ\n- ประวัติลอตและรายการเบิกเงินกำไรทั้งหมดจะถูกล้าง\n- ระบบจะตั้งต้นเป็น 'ลอตที่ 1' (ต้นทุน ฿5,000 / เงินทอน ฿500 / ยอดขาย ฿0) ใหม่เอี่ยม\n\nกด ตกลง (OK) เพื่อยืนยันการล้างข้อมูล";
  if (!confirm(confirmMsg)) return;

  const confirmText = prompt('เพื่อความปลอดภัยสูงสุด กรุณาพิมพ์คำว่า "RESET" หรือ "ล้างข้อมูล" ในช่องด้านล่างเพื่อยืนยัน:');
  if (!confirmText || (confirmText.trim().toUpperCase() !== 'RESET' && confirmText.trim() !== 'ล้างข้อมูล')) {
    showToast('ยกเลิกการรีเซ็ตระบบ (คำยืนยันไม่ถูกต้อง)', 'info');
    return;
  }

  showToast('กำลังทำการ Factory Reset ล้างข้อมูลระบบทั้งหมด...', 'info');

  // 1. Clear Online Supabase DB if connected
  if (!isOfflineMode && supabaseClient) {
    try {
      // Delete all withdrawals (if table exists)
      try {
        await supabaseClient
          .from('withdrawals')
          .delete()
          .neq('id', '00000000-0000-0000-0000-000000000000');
      } catch (wErr) {}

      // Delete all daily_sales
      await supabaseClient
        .from('daily_sales')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      // Delete all lots
      await supabaseClient
        .from('lots')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      // Insert fresh active Lot 1
      await supabaseClient
        .from('lots')
        .insert([{
          cost: 5000,
          float_money: 500,
          total_collected: 0,
          status: 'active'
        }]);
    } catch (err) {
      console.error('Factory reset error on Supabase:', err);
      showToast('เกิดข้อผิดพลาดในการล้างฐานข้อมูล Supabase', 'error');
    }
  }

  // 2. Clear Local Storage completely
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOTS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_SALES);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_PO_META);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_WITHDRAWALS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOT_ORDERS);
  localStorage.removeItem(STORAGE_KEYS.LOCAL_LOT_NOTES);
  localStorage.removeItem(STORAGE_KEYS.PENDING_SALES_QUEUE);

  closeModal('config-modal');
  showToast('🎉 รีเซ็ตระบบทั้งหมดสำเร็จแล้ว! กำลังเริ่มลอตที่ 1 ใหม่...', 'success');
  setTimeout(() => window.location.reload(), 1000);
}

// ========================================================
// 4.6 System Backup & Restore (.json)
// ========================================================
async function downloadSystemBackupJSON() {
  try {
    showToast('กำลังเตรียมข้อมูลสำรองระบบ...', 'info');

    let allLots = [];
    let allSales = [];
    const allWithdrawals = await fetchWithdrawals();

    // Fetch from Supabase if online
    if (!isOfflineMode && supabaseClient) {
      try {
        const { data: lotsData, error: lotErr } = await supabaseClient
          .from('lots')
          .select('*')
          .order('created_at', { ascending: true });
        if (lotErr) throw lotErr;
        allLots = lotsData || [];

        const { data: salesData, error: saleErr } = await supabaseClient
          .from('daily_sales')
          .select('*')
          .order('created_at', { ascending: true });
        if (saleErr) throw saleErr;
        allSales = salesData || [];
      } catch (sbErr) {
        console.warn('Fallback to local data for backup:', sbErr);
        allLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
        allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
      }
    } else {
      allLots = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOTS) || '[]');
      allSales = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_SALES) || '[]');
    }

    const backupPayload = {
      app: "Wall's Ice Cream POS & Batch Tracker",
      version: '2.1',
      exported_at: new Date().toISOString(),
      summary: {
        total_lots: allLots.length,
        total_sales_records: allSales.length,
        total_withdrawals: allWithdrawals.length,
        catalog_products_count: productCatalog.length
      },
      lots: allLots,
      daily_sales: allSales,
      products: productCatalog,
      order_draft: orderDraftQuantities || {},
      po_meta: JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_PO_META) || '{}'),
      withdrawals: allWithdrawals,
      lot_orders: JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_ORDERS) || '{}'),
      lot_notes: JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_NOTES) || '{}')
    };

    const jsonString = JSON.stringify(backupPayload, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateFormatted = getLocalDateISO();
    a.href = url;
    a.download = `walls_pos_backup_${dateFormatted}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`ดาวน์โหลดไฟล์สำรอง "${a.download}" สำเร็จแล้ว!`, 'success');
  } catch (err) {
    console.error('Backup download error:', err);
    showToast('เกิดข้อผิดพลาดในการสร้างไฟล์สำรองข้อมูล', 'error');
  }
}

function triggerRestoreSystem() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const fileInput = document.getElementById('restore-file-input');
  if (fileInput) {
    fileInput.value = ''; // reset previous file selection
    fileInput.click();
  }
}

async function handleRestoreFileSelected(event) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (!file.name.endsWith('.json')) {
    showToast('กรุณาเลือกไฟล์สำรองนามสกุล .json เท่านั้น', 'error');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target.result;
      const parsed = JSON.parse(content);

      // Validate structure
      if (!parsed || !Array.isArray(parsed.lots) || !Array.isArray(parsed.daily_sales)) {
        showToast('ไฟล์ไม่ถูกต้อง: โครงสร้างข้อมูลไม่ตรงกับไฟล์สำรองของระบบ Wall\'s POS', 'error');
        event.target.value = '';
        return;
      }

      const lotCount = parsed.lots.length;
      const saleCount = parsed.daily_sales.length;
      const backupDateStr = parsed.exported_at
        ? new Date(parsed.exported_at).toLocaleString('th-TH')
        : 'ไม่ระบุ';

      const confirmMsg = `⚠️ ยืนยันการกู้คืนข้อมูลระบบ (Restore Data)?\n\n` +
        `📅 วันที่บันทึกสำรอง: ${backupDateStr}\n` +
        `📦 จำนวนลอต: ${lotCount} ลอต\n` +
        `🧾 จำนวนยอดขายรายวัน: ${saleCount} รายการ\n\n` +
        `คำเตือน: ข้อมูลในระบบปัจจุบันทั้งหมดจะถูกแทนที่ด้วยข้อมูลจากไฟล์นี้ ยืนยันกด "ตกลง" (OK)`;

      if (!confirm(confirmMsg)) {
        event.target.value = '';
        return;
      }

      showToast('กำลังกู้คืนข้อมูลระบบ กรุณารอสักครู่...', 'info');

      // Cleaned lots
      const cleanedLots = parsed.lots.map(l => ({
        id: l.id,
        cost: parseLotCost(l.cost, 5000),
        float_money: roundMoney(l.float_money !== undefined ? l.float_money : 500),
        total_collected: roundMoney(l.total_collected || 0),
        status: l.status || 'active',
        created_at: l.created_at || new Date().toISOString(),
        closed_at: l.closed_at || null
      }));

      // Cleaned sales
      const cleanedSales = parsed.daily_sales.map(s => ({
        id: s.id,
        lot_id: s.lot_id,
        amount: roundMoney(s.amount || 0),
        shift: s.shift || 'lunch',
        note: s.note || '',
        float_deducted: roundMoney(s.float_deducted || 0),
        created_at: s.created_at || new Date().toISOString()
      }));

      // 1. Restore to Supabase Cloud if online
      if (!isOfflineMode && supabaseClient) {
        try {
          try {
            await supabaseClient.from('withdrawals').delete().neq('id', '00000000-0000-0000-0000-000000000000');
          } catch (wDelErr) {}

          await supabaseClient.from('daily_sales').delete().neq('id', '00000000-0000-0000-0000-000000000000');
          await supabaseClient.from('lots').delete().neq('id', '00000000-0000-0000-0000-000000000000');

          // Insert lots first (foreign key dependency)
          if (cleanedLots.length > 0) {
            const { error: lotErr } = await supabaseClient.from('lots').insert(cleanedLots);
            if (lotErr) console.warn('Supabase lots restore warning:', lotErr);
          }

          // Insert daily sales in batches
          if (cleanedSales.length > 0) {
            for (let i = 0; i < cleanedSales.length; i += 50) {
              const chunk = cleanedSales.slice(i, i + 50);
              const { error: saleErr } = await supabaseClient.from('daily_sales').insert(chunk);
              if (saleErr) console.warn('Supabase sales restore warning:', saleErr);
            }
          }

          if (parsed.withdrawals && Array.isArray(parsed.withdrawals) && parsed.withdrawals.length > 0) {
            try {
              await supabaseClient.from('withdrawals').insert(parsed.withdrawals);
            } catch (wInsErr) {}
          }
        } catch (sbErr) {
          console.error('Supabase restore error:', sbErr);
          showToast('เกิดข้อผิดพลาดในการบันทึกลง Supabase กำลังกู้คืนในเครื่องแทน', 'warning');
        }
      }

      // 2. Restore to LocalStorage
      localStorage.setItem(STORAGE_KEYS.LOCAL_LOTS, JSON.stringify(cleanedLots));
      localStorage.setItem(STORAGE_KEYS.LOCAL_SALES, JSON.stringify(cleanedSales));
      if (parsed.products && Array.isArray(parsed.products) && parsed.products.length > 0) {
        localStorage.setItem(STORAGE_KEYS.LOCAL_PRODUCTS, JSON.stringify(parsed.products));
      }
      if (parsed.order_draft) {
        localStorage.setItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT, JSON.stringify(parsed.order_draft));
      }
      if (parsed.po_meta) {
        localStorage.setItem(STORAGE_KEYS.LOCAL_PO_META, JSON.stringify(parsed.po_meta));
      }
      if (parsed.withdrawals && Array.isArray(parsed.withdrawals)) {
        localStorage.setItem(STORAGE_KEYS.LOCAL_WITHDRAWALS, JSON.stringify(parsed.withdrawals));
      }
      if (parsed.lot_orders && typeof parsed.lot_orders === 'object') {
        localStorage.setItem(STORAGE_KEYS.LOCAL_LOT_ORDERS, JSON.stringify(parsed.lot_orders));
      }
      if (parsed.lot_notes && typeof parsed.lot_notes === 'object') {
        localStorage.setItem(STORAGE_KEYS.LOCAL_LOT_NOTES, JSON.stringify(parsed.lot_notes));
      }

      await syncLocalMetadataToCloud();

      closeModal('config-modal');
      showToast('🎉 กู้คืนข้อมูลระบบสำเร็จสมบูรณ์! กำลังรีเฟรช...', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 1200);

    } catch (parseErr) {
      console.error('File parsing error:', parseErr);
      showToast('ไม่สามารถอ่านไฟล์ได้ กรุณาตรวจสอบว่าเป็นไฟล์ JSON ที่ถูกต้อง', 'error');
    } finally {
      event.target.value = '';
    }
  };

  reader.onerror = () => {
    showToast('เกิดข้อผิดพลาดในการเปิดไฟล์', 'error');
    event.target.value = '';
  };

  reader.readAsText(file, 'utf-8');
}

// ========================================================
// 5. Tab Navigation (Supports both Laptop & Mobile)
// ========================================================
function switchTab(tabId) {
  // If in Director View Mode, strictly restrict to 'profit' or 'history'
  if (isDirectorViewMode() && ['dashboard', 'input', 'products'].includes(tabId)) {
    tabId = 'profit';
  }

  // Hide all sections
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));

  // Reset Mobile Nav buttons
  document.querySelectorAll('.mob-nav-btn').forEach(btn => {
    btn.classList.remove('active', 'text-rose-600');
    btn.classList.add('text-slate-400');
  });

  // Reset Desktop Nav buttons
  document.querySelectorAll('.desk-nav-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-white', 'text-rose-600', 'shadow-sm');
    btn.classList.add('text-white/90');
  });

  // Activate target pane
  const targetPane = document.getElementById(`tab-${tabId}`);
  if (targetPane) targetPane.classList.remove('hidden');

  // Activate Mobile Nav button
  const targetMobNav = document.getElementById(`nav-btn-${tabId}`);
  if (targetMobNav) {
    targetMobNav.classList.add('active', 'text-rose-600');
    targetMobNav.classList.remove('text-slate-400');
  }

  // Activate Desktop Nav button
  const targetDeskNav = document.getElementById(`desk-nav-${tabId}`);
  if (targetDeskNav) {
    targetDeskNav.classList.add('active', 'bg-white', 'text-rose-600', 'shadow-sm');
    targetDeskNav.classList.remove('text-white/90');
  }

  // Trigger data reload for specific tabs
  if (tabId === 'dashboard') {
    loadActiveLotData();
  } else if (tabId === 'history') {
    loadHistoryData();
    if (isDirectorViewMode()) recordDirectorVisitActivity('ประวัติลอต');
  } else if (tabId === 'input') {
    updateInputField();
  } else if (tabId === 'products') {
    loadProductCatalog();
  } else if (tabId === 'profit') {
    loadProfitLedgerData();
    if (isDirectorViewMode()) recordDirectorVisitActivity('สมุดบัญชีกำไร');
  }

  // Smooth scroll back to top when switching tabs
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========================================================
// 6. Product Catalog, Margin Calculator & Purchase Order PDF
// ========================================================
function getDefaultWallsProducts() {
  return [
    // --- 1. กลุ่มแพดเดิลป๊อป (6 รายการ) ---
    { id: 'paddlepop-big-rocket', name: 'บิ๊ก ร็อกเก็ต เจลลี่', category: 'แพดเดิลป๊อป', pieces_per_box: 30, cost_per_piece: 8.04, box_cost: 241.29, retail_price: 10.00 },
    { id: 'paddlepop-choc-lava', name: 'ช็อก ลาวา', category: 'แพดเดิลป๊อป', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },
    { id: 'paddlepop-rainbow', name: 'เรนโบว์', category: 'แพดเดิลป๊อป', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },
    { id: 'paddlepop-dragon-pop', name: 'ดราก้อน ป๊อป', category: 'แพดเดิลป๊อป', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },
    { id: 'paddlepop-ovaltine', name: 'โอวัลติน', category: 'แพดเดิลป๊อป', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },
    { id: 'paddlepop-octopus', name: 'ออคโตปุส', category: 'แพดเดิลป๊อป', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },

    // --- 2. กลุ่มวอลล์ (39 รายการ) ---
    { id: 'walls-fruity', name: 'ฟรุตตี้', category: 'วอลล์', pieces_per_box: 60, cost_per_piece: 4.01, box_cost: 240.75, retail_price: 5.00 },
    { id: 'walls-cola', name: 'โคล่า', category: 'วอลล์', pieces_per_box: 60, cost_per_piece: 4.01, box_cost: 240.75, retail_price: 5.00 },
    { id: 'walls-mini-football', name: 'มินิ ฟุตบอล (ใหม่)', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 8.04, box_cost: 241.20, retail_price: 10.00 },
    { id: 'walls-little-ghost', name: 'ลิตเติ้ล โกสท์', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 8.04, box_cost: 241.20, retail_price: 10.00 },
    { id: 'walls-cone-hokkaido', name: 'วอลล์โคน นมฮอกไกโด', category: 'วอลล์', pieces_per_box: 40, cost_per_piece: 8.04, box_cost: 321.60, retail_price: 10.00 },
    { id: 'walls-cone-chocolate', name: 'วอลล์โคน ช็อกโกแลต', category: 'วอลล์', pieces_per_box: 40, cost_per_piece: 8.04, box_cost: 321.60, retail_price: 10.00 },
    { id: 'walls-mini-mochi-strawberry', name: 'มินิโมจิ สตรอเบอร์รี (ใหม่)', category: 'วอลล์', pieces_per_box: 40, cost_per_piece: 8.04, box_cost: 321.60, retail_price: 10.00 },
    { id: 'walls-mini-mochi-vanilla', name: 'มินิโมจิ วานิลลา', category: 'วอลล์', pieces_per_box: 40, cost_per_piece: 8.04, box_cost: 321.60, retail_price: 10.00 },
    { id: 'walls-mini-mochi-chocolate', name: 'มินิโมจิ ช็อกโกแลต', category: 'วอลล์', pieces_per_box: 40, cost_per_piece: 8.04, box_cost: 321.60, retail_price: 10.00 },
    { id: 'walls-giant-twin-cola', name: 'ยักษ์คู่ กลิ่นโคล่า', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 8.04, box_cost: 241.29, retail_price: 10.00 },
    { id: 'walls-giant-twin-orange', name: 'ยักษ์คู่ กลิ่นส้ม', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 8.04, box_cost: 241.29, retail_price: 10.00 },
    { id: 'walls-watermelon', name: 'แตงโม', category: 'วอลล์', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },
    { id: 'walls-cookie-cream', name: 'คุกกี้ แอนด์ ครีม', category: 'วอลล์', pieces_per_box: 36, cost_per_piece: 8.04, box_cost: 289.44, retail_price: 10.00 },
    { id: 'walls-minion-caramel', name: 'มินเนี่ยน คาราเมล (ใหม่)', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 12.06, box_cost: 289.44, retail_price: 15.00 },
    { id: 'walls-buzz-rocket-pop', name: 'บัซ ร็อกเก็ต ป๊อป (ใหม่)', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 12.06, box_cost: 361.80, retail_price: 15.00 },
    { id: 'walls-iceball-watermelon', name: 'ไอซ์บอลส์ แตงโม (ใหม่)', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 12.06, box_cost: 361.80, retail_price: 15.00 },
    { id: 'walls-shots-lime', name: 'ช็อทส์ ไลม์ (ใหม่)', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 12.06, box_cost: 361.80, retail_price: 15.00 },
    { id: 'walls-shots-fruity', name: 'ช็อทส์ ฟรุตตี้', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 12.05, box_cost: 361.39, retail_price: 15.00 },
    { id: 'walls-sweetheart', name: 'สวีตฮาร์ท', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 12.06, box_cost: 289.44, retail_price: 15.00 },
    { id: 'walls-waffle-strawberry', name: 'วาฟเฟิล สตรอเบอร์รี (ใหม่)', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 12.06, box_cost: 289.44, retail_price: 15.00 },
    { id: 'walls-waffle-milk', name: 'วาฟเฟิล รสนม', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 12.06, box_cost: 289.44, retail_price: 15.00 },
    { id: 'walls-twister-grape-lychee', name: 'ทวิสเตอร์ องุ่น ลิ้นจี่', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 12.06, box_cost: 289.44, retail_price: 15.00 },
    { id: 'walls-fruity-max', name: 'ฟรุตตี้ แม็กซ์', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 12.06, box_cost: 301.47, retail_price: 15.00 },
    { id: 'walls-solero-split-lime', name: 'โซเลโร สปลิท รสมะนาว', category: 'วอลล์', pieces_per_box: 30, cost_per_piece: 12.06, box_cost: 361.77, retail_price: 15.00 },
    { id: 'walls-calippo-slush-orange', name: 'คาลิปโป สลัช ครัช ส้ม (ใหม่)', category: 'วอลล์', pieces_per_box: 20, cost_per_piece: 16.08, box_cost: 321.60, retail_price: 20.00 },
    { id: 'walls-lava-delight', name: 'ลาวา ดีไลท์ (ใหม่)', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 16.08, box_cost: 402.00, retail_price: 20.00 },
    { id: 'walls-mochi-milky', name: 'โมจิ มิลค์กี้', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'walls-calippo-cola-lemon', name: 'คาลิปโป โคลา เลมอน', category: 'วอลล์', pieces_per_box: 28, cost_per_piece: 16.08, box_cost: 450.25, retail_price: 20.00 },
    { id: 'walls-bites-time-vanilla-caramel', name: 'ไบท์ส ไทม์ วานิลลา และ คาราเมล', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'walls-bites-time-strawberry', name: 'ไบท์ส ไทม์ สตรอเบอร์รี', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },
    { id: 'walls-viennetta-chocolate', name: 'เวียนเน็ตตา ช็อกโกแลต (ใหม่)', category: 'วอลล์', pieces_per_box: 18, cost_per_piece: 24.12, box_cost: 434.15, retail_price: 30.00 },
    { id: 'walls-ovaltine-whitemalt', name: 'โอวัลติน ไวท์มอลต์ ครันชี่', category: 'วอลล์', pieces_per_box: 24, cost_per_piece: 24.12, box_cost: 578.87, retail_price: 30.00 },
    { id: 'walls-iceball-lemon', name: 'ไอซ์บอลส์ เลมอน (ใหม่)', category: 'วอลล์', pieces_per_box: 20, cost_per_piece: 28.14, box_cost: 562.82, retail_price: 35.00 },
    { id: 'walls-iceball-grape', name: 'ไอซ์บอลส์ องุ่น', category: 'วอลล์', pieces_per_box: 20, cost_per_piece: 28.14, box_cost: 562.82, retail_price: 35.00 },
    { id: 'walls-topten-vanilla', name: 'ท็อปเทน วานิลลา', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 16.09, box_cost: 402.32, retail_price: 20.00 },
    { id: 'walls-topten-chocolate', name: 'ท็อปเทน ช็อกโกแลต', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 16.09, box_cost: 402.32, retail_price: 20.00 },
    { id: 'walls-topten-cornflakes', name: 'ท็อปเทน มิลค์ & คอร์นเฟลกส์', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 16.09, box_cost: 402.32, retail_price: 20.00 },
    { id: 'walls-topten-extra-strawberry', name: 'ท็อปเทน เอ็กซ์ตร้า สตรอเบอร์รี (ใหม่)', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 20.10, box_cost: 502.49, retail_price: 25.00 },
    { id: 'walls-topten-extra-chocolate', name: 'ท็อปเทน เอ็กซ์ตร้า ช็อกโกแลต', category: 'วอลล์', pieces_per_box: 25, cost_per_piece: 20.10, box_cost: 502.49, retail_price: 25.00 },

    // --- 3. กลุ่มเอเชียน ดีไลท์ (3 รายการ) ---
    { id: 'walls-asian-durian', name: 'ทุเรียนหมอนทอง', category: 'เอเชียน ดีไลท์', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },
    { id: 'walls-asian-taro', name: 'เผือก', category: 'เอเชียน ดีไลท์', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },
    { id: 'walls-asian-blackbean', name: 'ถั่วดำ', category: 'เอเชียน ดีไลท์', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },

    // --- 4. กลุ่มวอลล์คัพ (7 รายการ) ---
    { id: 'walls-cup-chocchip', name: 'คัพ ช็อกชิป', category: 'วอลล์คัพ', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'walls-cup-chocolate', name: 'คัพ ช็อกโกแลต', category: 'วอลล์คัพ', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'walls-cup-vanilla', name: 'คัพ วานิลลา', category: 'วอลล์คัพ', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'walls-cup-lime', name: 'คัพ มะนาว', category: 'วอลล์คัพ', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'walls-cup-coconut', name: 'คัพ กะทิ', category: 'วอลล์คัพ', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },
    { id: 'walls-cup-ovaltine', name: 'คัพ โอวัลติน', category: 'วอลล์คัพ', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },
    { id: 'walls-cup-butterbear-toy', name: 'บัตเตอร์แบร์ ทอย (ใหม่)', category: 'วอลล์คัพ', pieces_per_box: 20, cost_per_piece: 32.16, box_cost: 643.20, retail_price: 40.00 },

    // --- 5. กลุ่มคอร์นเนตโต (7 รายการ) ---
    { id: 'cornetto-classic-vanilla', name: 'คลาสสิก วานิลลา', category: 'คอร์นเนตโต', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'cornetto-classic-darkchoc', name: 'คลาสสิก ดาร์ค ช็อกโกแลต บราวนี่', category: 'คอร์นเนตโต', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'cornetto-classic-strawberry', name: 'คลาสสิก สตรอเบอร์รี คุกกี้', category: 'คอร์นเนตโต', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'cornetto-classic-cookie-cream', name: 'คลาสสิก คุกกี้ แอนด์ ครีม', category: 'คอร์นเนตโต', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 386.00, retail_price: 20.00 },
    { id: 'cornetto-muscat-yogurt', name: 'องุ่น มัสแคท & โยเกิร์ต (ใหม่)', category: 'คอร์นเนตโต', pieces_per_box: 24, cost_per_piece: 16.08, box_cost: 385.92, retail_price: 20.00 },
    { id: 'cornetto-royale-choclove', name: 'รอยัล ช็อกโกเลิฟ', category: 'คอร์นเนตโต', pieces_per_box: 20, cost_per_piece: 28.14, box_cost: 562.82, retail_price: 35.00 },
    { id: 'cornetto-royale-strawberry', name: 'รอยัล สตรอเบอร์รี', category: 'คอร์นเนตโต', pieces_per_box: 20, cost_per_piece: 28.14, box_cost: 562.82, retail_price: 35.00 },

    // --- 6. กลุ่มแม็กนั่ม (10 รายการ) ---
    { id: 'magnum-almond', name: 'แม็กนั่ม อัลมอนด์', category: 'แม็กนั่ม', pieces_per_box: 24, cost_per_piece: 40.21, box_cost: 965.14, retail_price: 50.00 },
    { id: 'magnum-classic', name: 'แม็กนั่ม คลาสสิค', category: 'แม็กนั่ม', pieces_per_box: 24, cost_per_piece: 40.21, box_cost: 965.14, retail_price: 50.00 },
    { id: 'magnum-white-almond', name: 'แม็กนั่ม ไวท์ อัลมอนด์', category: 'แม็กนั่ม', pieces_per_box: 24, cost_per_piece: 40.21, box_cost: 965.14, retail_price: 50.00 },
    { id: 'magnum-choc-luxe', name: 'ช็อกโกแลต ลักซ์', category: 'แม็กนั่ม', pieces_per_box: 24, cost_per_piece: 40.20, box_cost: 964.80, retail_price: 50.00 },
    { id: 'magnum-matcha-crumble', name: 'มัทฉะ ครัมเบิ้ล', category: 'แม็กนั่ม', pieces_per_box: 24, cost_per_piece: 40.21, box_cost: 965.14, retail_price: 50.00 },
    { id: 'magnum-pistachio', name: 'แม็กนั่ม พิสตาชิโอ (ใหม่)', category: 'แม็กนั่ม', pieces_per_box: 24, cost_per_piece: 40.20, box_cost: 964.80, retail_price: 50.00 },
    { id: 'magnum-cone-trio', name: 'แม็กนั่ม โคนทริโอ เพรสทีจ (ใหม่)', category: 'แม็กนั่ม', pieces_per_box: 18, cost_per_piece: 40.20, box_cost: 723.60, retail_price: 50.00 },
    { id: 'magnum-mini-almond-pack6', name: 'แม็กนั่ม มินิ อัลมอนด์ แพ็ค 6', category: 'แม็กนั่ม', pieces_per_box: 6, cost_per_piece: 160.10, box_cost: 960.59, retail_price: 199.00 },
    { id: 'magnum-mini-brownie-pack6', name: 'แม็กนั่ม มินิ บราวนี่ แพ็ค 6', category: 'แม็กนั่ม', pieces_per_box: 6, cost_per_piece: 160.10, box_cost: 960.59, retail_price: 199.00 },
    { id: 'magnum-mini-pistachio-pack6', name: 'แม็กนั่ม มินิ พิสตาชิโอ แพ็ค 6 (ใหม่)', category: 'แม็กนั่ม', pieces_per_box: 6, cost_per_piece: 160.00, box_cost: 959.97, retail_price: 199.00 },

    // --- 7. กลุ่มกล่องตัก / ดีลักซ์ (15 รายการ) ---
    { id: 'walls-classic-tub-small-2in1', name: '2 in 1 ช็อกชิป และ ช็อกโกแลต (กล่องเล็ก)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 8, cost_per_piece: 39.39, box_cost: 315.16, retail_price: 49.00 },
    { id: 'walls-classic-tub-choc-chocchip', name: 'ช็อกโกแลต ช็อกชิป (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.54, box_cost: 429.22, retail_price: 89.00 },
    { id: 'walls-classic-tub-lime-delight', name: 'มะนาว ดีไลท์ (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.54, box_cost: 429.22, retail_price: 89.00 },
    { id: 'walls-classic-tub-chocchip', name: 'ช็อกชิป (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.54, box_cost: 429.22, retail_price: 89.00 },
    { id: 'walls-classic-tub-vanilla', name: 'วานิลลา (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.54, box_cost: 429.22, retail_price: 89.00 },
    { id: 'walls-classic-tub-ruammit', name: 'รวมมิตร (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.54, box_cost: 429.22, retail_price: 89.00 },
    { id: 'walls-classic-tub-2in1-chocchip-choc', name: '2 in 1 ช็อกชิป และ ช็อกโกแลต (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.57, box_cost: 429.43, retail_price: 89.00 },
    { id: 'walls-classic-tub-3in1-neapolitan', name: '3 in 1 นีโอโพลิแทน (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.57, box_cost: 429.43, retail_price: 89.00 },
    { id: 'walls-classic-tub-3in1-triple-choc', name: '3 in 1 ทริปเปิ้ล ช็อกโกแลต (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.57, box_cost: 429.43, retail_price: 89.00 },
    { id: 'walls-classic-tub-3in1-triple-delight', name: '3 in 1 ทริปเปิ้ล ดีไลท์ (กล่องใหญ่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 71.57, box_cost: 429.43, retail_price: 89.00 },
    { id: 'walls-selection-cookies-cream', name: 'ซีเล็คชั่น คุกกี้ แอนด์ ครีม', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 4, cost_per_piece: 71.60, box_cost: 286.42, retail_price: 89.00 },
    { id: 'walls-deluxe-vanilla', name: 'ดีลักซ์ วานิลลา (ใหม่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 87.63, box_cost: 525.81, retail_price: 109.00 },
    { id: 'walls-deluxe-strawberry', name: 'ดีลักซ์ สตรอเบอร์รี (ใหม่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 87.63, box_cost: 525.81, retail_price: 109.00 },
    { id: 'walls-deluxe-choc-brownie', name: 'ดีลักซ์ ช็อกโกแลต บราวนี่ (ใหม่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 87.63, box_cost: 525.81, retail_price: 109.00 },
    { id: 'walls-deluxe-caramel', name: 'ดีลักซ์ คาราเมล (ใหม่)', category: 'กล่องตัก/ดีลักซ์', pieces_per_box: 6, cost_per_piece: 87.63, box_cost: 525.81, retail_price: 109.00 }
  ];
}

async function loadProductCatalog() {
  // Load saved order draft quantities
  try {
    orderDraftQuantities = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT) || '{}');
  } catch (e) {
    orderDraftQuantities = {};
  }

  // Try loading from Supabase if online and table exists, else fallback cleanly to LocalStorage
  let loaded = null;
  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('products')
        .select('*')
        .order('created_at', { ascending: true });
      if (!error && Array.isArray(data) && data.length > 0) {
        loaded = data;
      }
    } catch (err) {
      // Fallback to local catalog if products table is not yet created
    }
  }

  const CATALOG_VERSION = 'v3_official_exact_vat_87';
  const currentCatalogVer = localStorage.getItem('walls_catalog_version');

  if (currentCatalogVer !== CATALOG_VERSION) {
    loaded = getDefaultWallsProducts();
    localStorage.setItem(STORAGE_KEYS.LOCAL_PRODUCTS, JSON.stringify(loaded));
    localStorage.setItem('walls_catalog_version', CATALOG_VERSION);
  } else if (!loaded || loaded.length < 50) {
    try {
      const localRaw = localStorage.getItem(STORAGE_KEYS.LOCAL_PRODUCTS);
      if (localRaw) {
        const parsed = JSON.parse(localRaw);
        if (Array.isArray(parsed) && parsed.length >= 80) {
          loaded = parsed;
        }
      }
    } catch (e) {}
    if (!loaded || loaded.length < 50) {
      loaded = getDefaultWallsProducts();
      localStorage.setItem(STORAGE_KEYS.LOCAL_PRODUCTS, JSON.stringify(loaded));
      localStorage.setItem('walls_catalog_version', CATALOG_VERSION);
    }
  }

  productCatalog = loaded;

  // If no order draft exists yet, initialize a helpful default selection (~5,000 THB budget) on first visit
  if (Object.keys(orderDraftQuantities).length === 0 && !localStorage.getItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT)) {
    autoFillOrderBudget(5000, true);
  } else {
    renderProductCatalog();
    updateOrderPlannerSummary();
  }
}

function saveProductCatalogLocal() {
  localStorage.setItem(STORAGE_KEYS.LOCAL_PRODUCTS, JSON.stringify(productCatalog));
}

function saveOrderDraftLocal() {
  localStorage.setItem(STORAGE_KEYS.LOCAL_ORDER_DRAFT, JSON.stringify(orderDraftQuantities));
}

function computeProductMetrics(prod) {
  const pieces = Math.max(1, parseInt(prod.pieces_per_box, 10) || 24);
  const retailPiece = Math.max(0, parseFloat(prod.retail_price) || 0);

  // If box_cost is explicitly defined on the product, use it directly (accurate to satang from official invoice)
  // Otherwise, fallback to cost_per_piece * pieces
  const rawCostPiece = Math.max(0, parseFloat(prod.cost_per_piece) || 0);
  const rawBoxCost = (prod.box_cost !== undefined && prod.box_cost !== null && !isNaN(parseFloat(prod.box_cost)))
    ? parseFloat(prod.box_cost)
    : (rawCostPiece * pieces);
  const boxCost = Math.round(rawBoxCost * 100) / 100;

  const costPiece = (prod.cost_per_piece !== undefined && prod.cost_per_piece !== null && !isNaN(parseFloat(prod.cost_per_piece)))
    ? parseFloat(prod.cost_per_piece)
    : (pieces > 0 ? Math.round((boxCost / pieces) * 100) / 100 : 0);

  const profitPerPiece = Math.round((retailPiece - costPiece) * 100) / 100;
  const marginPct = retailPiece > 0 ? (profitPerPiece / retailPiece) * 100 : 0;
  const boxRevenue = Math.round((retailPiece * pieces) * 100) / 100;
  const boxProfit = Math.round((boxRevenue - boxCost) * 100) / 100;

  return {
    pieces,
    costPiece,
    retailPiece,
    profitPerPiece,
    marginPct,
    boxCost,
    boxRevenue,
    boxProfit
  };
}

function setProductCategoryFilter(category) {
  currentProductCategory = category;
  document.querySelectorAll('.prod-cat-btn').forEach(btn => {
    if (btn.getAttribute('data-cat') === category) {
      btn.className = 'prod-cat-btn active px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 text-white transition whitespace-nowrap';
    } else {
      btn.className = 'prod-cat-btn px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 transition whitespace-nowrap';
    }
  });
  renderProductCatalog();
}

function renderProductCatalog() {
  const tbody = document.getElementById('product-catalog-tbody');
  const cardsContainer = document.getElementById('product-catalog-cards');
  const countLabel = document.getElementById('product-count-label');
  if (!tbody) return;

  const searchInput = document.getElementById('product-search-input');
  const sortSelect = document.getElementById('product-sort-select');
  const keyword = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const sortBy = sortSelect ? sortSelect.value : 'default';

  let list = productCatalog.map(p => ({
    ...p,
    metrics: computeProductMetrics(p)
  }));

  if (currentProductCategory !== 'all') {
    list = list.filter(p => p.category === currentProductCategory);
  }

  if (keyword) {
    list = list.filter(p =>
      p.name.toLowerCase().includes(keyword) ||
      (p.category && p.category.toLowerCase().includes(keyword))
    );
  }

  if (sortBy === 'box_profit_desc') {
    list.sort((a, b) => b.metrics.boxProfit - a.metrics.boxProfit);
  } else if (sortBy === 'piece_profit_desc') {
    list.sort((a, b) => b.metrics.profitPerPiece - a.metrics.profitPerPiece);
  } else if (sortBy === 'margin_desc') {
    list.sort((a, b) => b.metrics.marginPct - a.metrics.marginPct);
  } else if (sortBy === 'retail_asc') {
    list.sort((a, b) => a.metrics.retailPiece - b.metrics.retailPiece);
  }

  if (countLabel) {
    countLabel.innerText = `แสดง ${list.length} จาก ${productCatalog.length} รายการ`;
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="py-10 text-center text-slate-400">ไม่พบรายการสินค้าที่ค้นหา</td></tr>`;
    if (cardsContainer) {
      cardsContainer.innerHTML = `<div class="bg-white rounded-2xl p-6 text-center text-xs text-slate-400 border border-slate-200">ไม่พบรายการสินค้าที่ค้นหา</div>`;
    }
    return;
  }

  const catIcons = {
    'โคน': '🍦',
    'แท่ง': '🍭',
    'ถ้วย': '🍨',
    'แซนด์วิช/อื่นๆ': '🥪'
  };

  tbody.innerHTML = list.map(p => {
    const m = p.metrics;
    const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
    const badgeHtml = getWallsFlavorBadge(p);

    return `
      <tr class="hover:bg-rose-50/40 transition ${qty > 0 ? 'bg-indigo-50/40' : ''}">
        <td class="py-3 px-3">
          <div class="font-bold text-slate-800">${escapeHtml(p.name)}</div>
          <div class="mt-1">${badgeHtml}</div>
        </td>
        <td class="py-3 px-2.5 text-center font-mono font-bold text-slate-700">${m.pieces} ชิ้น</td>
        <td class="py-3 px-2.5 text-right font-mono text-rose-600 font-semibold">฿${m.costPiece.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-2.5 text-right font-mono font-extrabold text-slate-900 bg-slate-50">฿${m.retailPiece.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-2.5 text-right font-mono">
          <span class="font-extrabold text-emerald-600">+฿${m.profitPerPiece.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span class="block text-[10px] text-slate-400">(${m.marginPct.toFixed(0)}%)</span>
        </td>
        <td class="py-3 px-2.5 text-right font-mono font-semibold text-rose-700">฿${m.boxCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-2.5 text-right font-mono font-semibold text-blue-700">฿${m.boxRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-3 text-right font-mono font-extrabold text-sm text-emerald-700 bg-emerald-50/60">+฿${m.boxProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="py-3 px-3 text-center bg-indigo-50/50">
          <div class="inline-flex items-center space-x-1 bg-white border border-indigo-200 rounded-xl p-1 shadow-sm">
            <button onclick="changeOrderQty('${p.id}', -1)" class="w-6 h-6 rounded-lg bg-slate-100 hover:bg-rose-100 text-slate-700 hover:text-rose-600 font-bold flex items-center justify-center transition">-</button>
            <input type="number" min="0" value="${qty}" onchange="setOrderQtyDirect('${p.id}', this.value)"
                   class="w-10 text-center font-mono font-extrabold text-xs ${qty > 0 ? 'text-indigo-700' : 'text-slate-400'} outline-none bg-transparent">
            <button onclick="changeOrderQty('${p.id}', 1)" class="w-6 h-6 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center justify-center transition">+</button>
          </div>
        </td>
        <td class="py-3 px-2.5 text-center">
          <div class="inline-flex items-center space-x-1">
            <button onclick="openProductModal('${p.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-500 hover:text-blue-600 flex items-center justify-center transition" title="แก้ไขสินค้า">
              <i class="fa-solid fa-pen text-[10px]"></i>
            </button>
            <button onclick="deleteProductById('${p.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-rose-50 text-slate-400 hover:text-rose-600 flex items-center justify-center transition" title="ลบสินค้า">
              <i class="fa-solid fa-trash-can text-[10px]"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (cardsContainer) {
    cardsContainer.innerHTML = list.map(p => {
      const m = p.metrics;
      const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
      const badgeHtml = getWallsFlavorBadge(p);

      return `
        <div class="bg-white rounded-3xl p-4 shadow-sm border ${qty > 0 ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-rose-100'} space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5 flex-wrap">
                ${badgeHtml}
                <span class="text-[10px] font-mono font-bold text-slate-500">• ${m.pieces} ชิ้น/ลัง</span>
              </div>
              <h4 class="font-bold text-sm text-slate-800 mt-1.5">${escapeHtml(p.name)}</h4>
            </div>
            <button onclick="openProductModal('${p.id}')" class="w-8 h-8 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
              <i class="fa-solid fa-pen text-xs"></i>
            </button>
          </div>

          <div class="grid grid-cols-3 gap-2 text-center bg-slate-50 p-2.5 rounded-2xl border border-slate-100 text-xs">
            <div>
              <span class="text-[10px] text-slate-400 block">ทุน/ชิ้น</span>
              <span class="font-mono font-bold text-rose-600">฿${m.costPiece.toFixed(2)}</span>
            </div>
            <div class="border-x border-slate-200">
              <span class="text-[10px] text-slate-400 block">ขายหน้าร้าน</span>
              <span class="font-mono font-extrabold text-slate-900">฿${m.retailPiece.toFixed(2)}</span>
            </div>
            <div>
              <span class="text-[10px] text-emerald-600 font-bold block">กำไร/แท่ง</span>
              <span class="font-mono font-extrabold text-emerald-600">+฿${m.profitPerPiece.toFixed(2)}</span>
            </div>
          </div>

          <div class="flex items-center justify-between bg-emerald-50/70 border border-emerald-200/80 px-3 py-2 rounded-2xl text-xs">
            <div>
              <span class="text-[10px] text-slate-500 block">ทุนยกลัง ฿${m.boxCost.toLocaleString('th-TH')} → ขายได้ ฿${m.boxRevenue.toLocaleString('th-TH')}</span>
              <span class="font-bold text-emerald-900">กำไรทั้งลัง: <strong class="font-mono text-sm text-emerald-700">+฿${m.boxProfit.toLocaleString('th-TH')}</strong></span>
            </div>
            <div class="flex items-center space-x-1.5 bg-white border border-indigo-200 rounded-xl p-1 shadow-sm">
              <button onclick="changeOrderQty('${p.id}', -1)" class="w-7 h-7 rounded-lg bg-slate-100 text-slate-700 font-bold">-</button>
              <span class="px-2 font-mono font-extrabold text-xs ${qty > 0 ? 'text-indigo-700' : 'text-slate-400'}">${qty} ลัง</span>
              <button onclick="changeOrderQty('${p.id}', 1)" class="w-7 h-7 rounded-lg bg-indigo-600 text-white font-bold">+</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function changeOrderQty(productId, delta) {
  const current = parseInt(orderDraftQuantities[productId] || 0, 10);
  const next = Math.max(0, current + delta);
  if (next === 0) {
    delete orderDraftQuantities[productId];
  } else {
    orderDraftQuantities[productId] = next;
  }
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
}

function setOrderQtyDirect(productId, val) {
  const parsed = Math.max(0, parseInt(val, 10) || 0);
  if (parsed === 0) {
    delete orderDraftQuantities[productId];
  } else {
    orderDraftQuantities[productId] = parsed;
  }
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
}

function clearOrderSelection() {
  orderDraftQuantities = {};
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
  showToast('ล้างจำนวนลังที่เลือกไว้เรียบร้อยแล้ว', 'info');
}

function autoFillOrderBudget(targetBudget = 5000, silent = false) {
  if (productCatalog.length === 0) return;
  orderDraftQuantities = {};
  let runningCost = 0;

  // Cycle through products to build a balanced assortment near ~5,000 THB
  let addedInPass = true;
  while (addedInPass && runningCost < targetBudget) {
    addedInPass = false;
    for (const p of productCatalog) {
      const m = computeProductMetrics(p);
      if (m.boxCost > 0 && runningCost + m.boxCost <= targetBudget + 250) {
        orderDraftQuantities[p.id] = (orderDraftQuantities[p.id] || 0) + 1;
        runningCost += m.boxCost;
        addedInPass = true;
        if (runningCost >= targetBudget - 150) break;
      }
    }
  }

  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
  if (!silent) {
    showToast(`จัดชุดสินค้าอัตโนมัติงบประมาณ ฿${runningCost.toLocaleString('th-TH')} เรียบร้อย! ปรับบวก/ลบเพิ่มได้ตามต้องการ`, 'success');
  }
}

function updateOrderPlannerSummary() {
  let totalBoxes = 0;
  let totalPieces = 0;
  let totalCost = 0;
  let totalRevenue = 0;
  let totalProfit = 0;

  for (const p of productCatalog) {
    const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
    if (qty > 0) {
      const m = computeProductMetrics(p);
      totalBoxes += qty;
      totalPieces += m.pieces * qty;
      totalCost += m.boxCost * qty;
      totalRevenue += m.boxRevenue * qty;
      totalProfit += m.boxProfit * qty;
    }
  }

  const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  const lotBudget = activeLot ? parseFloat(activeLot.cost) || 5000 : 5000;

  const elBoxes = document.getElementById('planner-total-boxes');
  const elPieces = document.getElementById('planner-total-pieces');
  const elCost = document.getElementById('planner-total-cost');
  const elRev = document.getElementById('planner-total-revenue');
  const elProfit = document.getElementById('planner-total-profit');
  const elMargin = document.getElementById('planner-avg-margin');
  const elBadgeBoxes = document.getElementById('planner-badge-boxes');
  const elBudgetBadge = document.getElementById('planner-budget-badge');

  if (elBoxes) elBoxes.innerText = `${totalBoxes.toLocaleString('th-TH')} ลัง`;
  if (elPieces) elPieces.innerText = `(${totalPieces.toLocaleString('th-TH')} ชิ้น)`;
  if (elCost) elCost.innerText = `฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (elRev) elRev.innerText = `฿${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (elProfit) elProfit.innerText = `+฿${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (elMargin) elMargin.innerText = `กำไร ${avgMargin.toFixed(1)}%`;
  if (elBadgeBoxes) elBadgeBoxes.innerText = totalBoxes;
  if (elBudgetBadge) {
    const diff = totalCost - lotBudget;
    if (totalCost === 0) {
      elBudgetBadge.innerText = `งบตั้งต้น ฿${lotBudget.toLocaleString('th-TH')}`;
    } else if (Math.abs(diff) <= 300) {
      elBudgetBadge.innerText = `ใกล้เคียงงบ ฿${lotBudget.toLocaleString('th-TH')}`;
    } else if (diff > 300) {
      elBudgetBadge.innerText = `เกินงบ +฿${diff.toLocaleString('th-TH')}`;
    } else {
      elBudgetBadge.innerText = `ต่ำกว่างบ ฿${Math.abs(diff).toLocaleString('th-TH')}`;
    }
  }
}

// --- Add / Edit Product Modal Logic ---
function openProductModal(productId = null) {
  const idInput = document.getElementById('prod-id-input');
  const nameInput = document.getElementById('prod-name-input');
  const catInput = document.getElementById('prod-category-input');
  const piecesInput = document.getElementById('prod-pieces-input');
  const retailInput = document.getElementById('prod-retail-input');
  const costPieceInput = document.getElementById('prod-cost-piece-input');
  const costBoxInput = document.getElementById('prod-cost-box-input');
  const titleEl = document.getElementById('product-modal-title');
  const btnDelete = document.getElementById('btn-delete-product-modal');

  if (productId) {
    const prod = productCatalog.find(p => p.id === productId);
    if (!prod) return;
    const m = computeProductMetrics(prod);
    titleEl.innerText = 'แก้ไขรายการสินค้าไอศกรีม';
    idInput.value = prod.id;
    nameInput.value = prod.name;
    catInput.value = prod.category || 'โคน';
    piecesInput.value = m.pieces;
    retailInput.value = m.retailPiece;
    costPieceInput.value = m.costPiece;
    costBoxInput.value = m.boxCost.toFixed(2);
    if (btnDelete) btnDelete.classList.remove('hidden');
  } else {
    titleEl.innerText = 'เพิ่มรายการสินค้าใหม่';
    idInput.value = '';
    nameInput.value = '';
    catInput.value = 'โคน';
    piecesInput.value = 24;
    retailInput.value = 20;
    costPieceInput.value = 15;
    costBoxInput.value = 360;
    if (btnDelete) btnDelete.classList.add('hidden');
  }

  onProductFormCalc('init');
  document.getElementById('product-modal').classList.remove('hidden');
}

function onProductFormCalc(source) {
  const pieces = Math.max(1, parseInt(document.getElementById('prod-pieces-input').value, 10) || 1);
  const retail = Math.max(0, parseFloat(document.getElementById('prod-retail-input').value) || 0);
  const costPieceEl = document.getElementById('prod-cost-piece-input');
  const costBoxEl = document.getElementById('prod-cost-box-input');

  let costPiece = parseFloat(costPieceEl.value) || 0;
  let costBox = parseFloat(costBoxEl.value) || 0;

  if (source === 'cost_box') {
    costPiece = costBox / pieces;
    costPieceEl.value = costPiece ? parseFloat(costPiece.toFixed(4)) : '';
  } else if (source === 'cost_piece' || source === 'pieces' || source === 'init') {
    costBox = costPiece * pieces;
    costBoxEl.value = costBox ? parseFloat(costBox.toFixed(2)) : '';
  }

  const profitPiece = retail - costPiece;
  const marginPct = retail > 0 ? (profitPiece / retail) * 100 : 0;
  const boxRev = retail * pieces;
  const boxProfit = boxRev - costBox;

  document.getElementById('prod-preview-piece-profit').innerText = `${profitPiece >= 0 ? '+' : ''}฿${profitPiece.toFixed(2)} (${marginPct.toFixed(1)}%)`;
  document.getElementById('prod-preview-box-rev').innerText = `฿${boxRev.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('prod-preview-box-profit').innerText = `${boxProfit >= 0 ? '+' : ''}฿${boxProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function handleSaveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('prod-id-input').value.trim();
  const name = document.getElementById('prod-name-input').value.trim();
  const category = document.getElementById('prod-category-input').value;
  const pieces_per_box = Math.max(1, parseInt(document.getElementById('prod-pieces-input').value, 10) || 24);
  const cost_per_piece = Math.max(0, parseFloat(document.getElementById('prod-cost-piece-input').value) || 0);
  const box_cost = Math.max(0, parseFloat(document.getElementById('prod-cost-box-input').value) || (cost_per_piece * pieces_per_box));
  const retail_price = Math.max(0, parseFloat(document.getElementById('prod-retail-input').value) || 0);

  if (!name) {
    showToast('กรุณาระบุชื่อสินค้า', 'error');
    return;
  }

  if (id) {
    const idx = productCatalog.findIndex(p => p.id === id);
    if (idx > -1) {
      productCatalog[idx] = { ...productCatalog[idx], name, category, pieces_per_box, cost_per_piece, box_cost, retail_price };
    }
    if (!isOfflineMode && supabaseClient) {
      try {
        await supabaseClient.from('products').upsert(productCatalog[idx]);
      } catch (err) {}
    }
    showToast(`อัปเดตสินค้า "${name}" เรียบร้อยแล้ว`, 'success');
  } else {
    const newProd = {
      id: generateUUID(),
      name,
      category,
      pieces_per_box,
      cost_per_piece,
      box_cost,
      retail_price
    };
    productCatalog.push(newProd);
    orderDraftQuantities[newProd.id] = 1;
    saveOrderDraftLocal();

    if (!isOfflineMode && supabaseClient) {
      try {
        await supabaseClient.from('products').insert([newProd]);
      } catch (err) {}
    }
    showToast(`เพิ่มสินค้า "${name}" เรียบร้อยแล้ว`, 'success');
  }

  saveProductCatalogLocal();
  closeModal('product-modal');
  renderProductCatalog();
  updateOrderPlannerSummary();
}

function handleDeleteProductFromModal() {
  const id = document.getElementById('prod-id-input').value.trim();
  if (!id) return;
  closeModal('product-modal');
  deleteProductById(id);
}

async function deleteProductById(productId) {
  const prod = productCatalog.find(p => p.id === productId);
  if (!prod) return;

  const confirmed = await showConfirmDialog({
    title: 'ยืนยันการลบสินค้า?',
    message: `ต้องการลบสินค้า "${prod.name}" ออกจากระบบใช่หรือไม่?`,
    confirmText: 'ยืนยันการลบ',
    cancelText: 'ยกเลิก',
    type: 'danger',
    icon: 'fa-trash-can'
  });

  if (!confirmed) return;

  productCatalog = productCatalog.filter(p => p.id !== productId);
  delete orderDraftQuantities[productId];

  if (!isOfflineMode && supabaseClient) {
    try {
      await supabaseClient.from('products').delete().eq('id', productId);
    } catch (err) {}
  }

  saveProductCatalogLocal();
  saveOrderDraftLocal();
  renderProductCatalog();
  updateOrderPlannerSummary();
  showToast(`ลบสินค้า "${prod.name}" เรียบร้อยแล้ว`, 'info');
}

async function resetDefaultProducts() {
  const confirmed = await showConfirmDialog({
    title: 'รีเซ็ตรายการสินค้าและราคาต้นทุน?',
    message: 'ต้องการรีเซ็ตรายการสินค้าและราคาต้นทุนกลับเป็นค่ามาตรฐานทางการ (87 รายการรวม VAT ตรงตามป้าย) ใช่หรือไม่?',
    confirmText: 'รีเซ็ตเป็นค่ามาตรฐาน',
    cancelText: 'ยกเลิก',
    type: 'warning',
    icon: 'fa-rotate-left'
  });

  if (!confirmed) return;
  productCatalog = getDefaultWallsProducts();
  saveProductCatalogLocal();
  localStorage.setItem('walls_catalog_version', 'v3_official_exact_vat_87');
  autoFillOrderBudget(5000, true);
  showToast('รีเซ็ตฐานข้อมูลสินค้าตรงตามป้ายทางการแล้ว', 'success');
}

// --- Purchase Order (ใบสั่งซื้อสินค้า A4 & PDF Export) ---
function openPurchaseOrderModal() {
  // Load saved PO metadata if available
  try {
    const savedMeta = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_PO_META) || '{}');
    if (savedMeta.buyer) document.getElementById('po-buyer-input').value = savedMeta.buyer;
    if (savedMeta.supplier) document.getElementById('po-supplier-input').value = savedMeta.supplier;
    if (savedMeta.note !== undefined) document.getElementById('po-note-input').value = savedMeta.note;
  } catch (e) {}

  renderPurchaseOrderContent();
  document.getElementById('po-report-modal').classList.remove('hidden');
}

function updatePOHeaderLive() {
  const buyer = document.getElementById('po-buyer-input').value.trim() || 'โครงการจำหน่ายไอศกรีมโรงเรียน';
  const supplier = document.getElementById('po-supplier-input').value.trim() || "ตัวแทนจำหน่ายไอศกรีมวอลล์ (Wall's)";
  const note = document.getElementById('po-note-input').value.trim() || '-';

  document.getElementById('po-sheet-buyer').innerText = `ผู้สั่งซื้อ: ${buyer}`;
  document.getElementById('po-sheet-supplier').innerText = `ผู้จำหน่าย: ${supplier}`;
  document.getElementById('po-sheet-note').innerText = note;

  localStorage.setItem(STORAGE_KEYS.LOCAL_PO_META, JSON.stringify({ buyer, supplier, note }));
}

function renderPurchaseOrderContent() {
  updatePOHeaderLive();

  const now = new Date();
  const dateStr = now.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  document.getElementById('po-sheet-date').innerText = dateStr;
  document.getElementById('po-sheet-number').innerText = `PO-${ymd}`;

  const modeSelect = document.getElementById('po-mode-select');
  const mode = modeSelect ? modeSelect.value : 'supplier'; // 'supplier' | 'internal'

  // Filter items that have order quantity > 0; if none selected, include all products with qty = 1 so PO is never blank
  let orderedItems = productCatalog
    .map(p => ({
      ...p,
      orderQty: parseInt(orderDraftQuantities[p.id] || 0, 10),
      metrics: computeProductMetrics(p)
    }))
    .filter(item => item.orderQty > 0);

  if (orderedItems.length === 0) {
    orderedItems = productCatalog.map(p => ({
      ...p,
      orderQty: 1,
      metrics: computeProductMetrics(p)
    }));
  }

  let totalBoxes = 0;
  let totalPieces = 0;
  let totalCost = 0;
  let totalRevenue = 0;
  let totalProfit = 0;

  orderedItems.forEach(item => {
    totalBoxes += item.orderQty;
    totalPieces += item.metrics.pieces * item.orderQty;
    totalCost += item.metrics.boxCost * item.orderQty;
    totalRevenue += item.metrics.boxRevenue * item.orderQty;
    totalProfit += item.metrics.boxProfit * item.orderQty;
  });

  const stripEl = document.getElementById('po-summary-strip');
  const theadEl = document.getElementById('po-table-thead');
  const tbodyEl = document.getElementById('po-table-tbody');
  const tfootEl = document.getElementById('po-table-tfoot');

  if (mode === 'supplier') {
    // Supplier Mode: Shows ONLY Product Name & Box Quantity for sending cleanly to the shop/supplier
    stripEl.className = 'grid grid-cols-2 gap-3 text-center';
    stripEl.innerHTML = `
      <div class="bg-slate-50 border border-slate-300 rounded-xl p-3">
        <span class="text-[11px] text-slate-500 block">จำนวนรายการที่สั่งซื้อ</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-slate-800">${orderedItems.length} รายการ</span>
      </div>
      <div class="bg-indigo-50 border border-indigo-300 rounded-xl p-3">
        <span class="text-[11px] text-indigo-700 font-bold block">รวมจำนวนที่สั่งซื้อทั้งหมด</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-indigo-700">${totalBoxes.toLocaleString('th-TH')} ลัง</span>
      </div>
    `;

    theadEl.innerHTML = `
      <tr class="bg-slate-800 text-white text-xs">
        <th style="width: 15%;" class="py-3 px-3 text-center">ลำดับที่</th>
        <th style="width: 60%;" class="py-3 px-4 text-left">รายการชื่อสินค้า</th>
        <th style="width: 25%;" class="py-3 px-4 text-center">จำนวนที่สั่งซื้อ (ลัง)</th>
      </tr>
    `;

    tbodyEl.innerHTML = orderedItems.map((item, idx) => {
      return `
        <tr class="even:bg-slate-50/70">
          <td class="py-2.5 px-3 text-center font-mono font-semibold text-slate-700">${idx + 1}</td>
          <td class="py-2.5 px-4 font-bold text-sm text-slate-900">${escapeHtml(item.name)}</td>
          <td class="py-2.5 px-4 text-center font-mono font-extrabold text-sm text-indigo-700">${item.orderQty} ลัง</td>
        </tr>
      `;
    }).join('');

    tfootEl.innerHTML = `
      <tr class="bg-slate-100 font-extrabold text-slate-900">
        <td colspan="2" class="py-3 px-4 text-right text-sm">รวมจำนวนสั่งซื้อทั้งสิ้น</td>
        <td class="py-3 px-4 text-center font-mono text-base text-indigo-700">${totalBoxes.toLocaleString('th-TH')} ลัง</td>
      </tr>
    `;
  } else {
    // Internal Analysis Mode: Shows cost, retail price, profit per piece, and total projected profit
    stripEl.className = 'grid grid-cols-3 gap-3 text-center';
    stripEl.innerHTML = `
      <div class="bg-rose-50 border border-rose-300 rounded-xl p-3">
        <span class="text-[11px] text-rose-700 font-bold block">ต้นทุนสั่งซื้อรวม (${totalBoxes} ลัง)</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-rose-700">฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="bg-blue-50 border border-blue-300 rounded-xl p-3">
        <span class="text-[11px] text-blue-700 font-bold block">ยอดขายรวมเมื่อขายหมด (${totalPieces} ชิ้น)</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-blue-700">฿${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="bg-emerald-50 border border-emerald-300 rounded-xl p-3">
        <span class="text-[11px] text-emerald-800 font-bold block">กำไรสุทธิคาดการณ์ทั้งลอต</span>
        <span class="text-base sm:text-lg font-extrabold font-mono text-emerald-700">+฿${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</span>
      </div>
    `;

    theadEl.innerHTML = `
      <tr class="bg-slate-800 text-white text-[11px]">
        <th style="width: 6%;" class="py-2.5 px-1.5 text-center">ลำดับ</th>
        <th style="width: 24%;" class="py-2.5 px-2.5 text-left">รายการสินค้า</th>
        <th style="width: 8%;" class="py-2.5 px-1.5 text-center">ชิ้น/ลัง</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ทุน/ชิ้น</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ขาย/ชิ้น</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">กำไร/แท่ง</th>
        <th style="width: 8%;" class="py-2.5 px-1.5 text-center">สั่ง (ลัง)</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ทุนรวม</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right">ขายรวม</th>
        <th style="width: 9%;" class="py-2.5 px-2 text-right text-emerald-300">กำไรรวม</th>
      </tr>
    `;

    tbodyEl.innerHTML = orderedItems.map((item, idx) => {
      const m = item.metrics;
      const lineCost = m.boxCost * item.orderQty;
      const lineRev = m.boxRevenue * item.orderQty;
      const lineProfit = m.boxProfit * item.orderQty;
      return `
        <tr class="even:bg-slate-50/70">
          <td class="py-2 px-1.5 text-center font-mono">${idx + 1}</td>
          <td class="py-2 px-2.5 font-bold text-slate-800">${escapeHtml(item.name)}</td>
          <td class="py-2 px-1.5 text-center font-mono">${m.pieces}</td>
          <td class="py-2 px-2 text-right font-mono">${m.costPiece.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-mono font-bold">${m.retailPiece.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-mono text-emerald-700">+${m.profitPerPiece.toFixed(2)}</td>
          <td class="py-2 px-1.5 text-center font-mono font-bold text-indigo-700">${item.orderQty}</td>
          <td class="py-2 px-2 text-right font-mono text-rose-700">${lineCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          <td class="py-2 px-2 text-right font-mono text-blue-700">${lineRev.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
          <td class="py-2 px-2 text-right font-mono font-bold text-emerald-700">+${lineProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        </tr>
      `;
    }).join('');

    tfootEl.innerHTML = `
      <tr class="bg-slate-100 font-extrabold text-slate-900">
        <td colspan="6" class="py-2.5 px-3 text-right">รวมทั้งสิ้น (${totalPieces.toLocaleString('th-TH')} ชิ้น)</td>
        <td class="py-2.5 px-1.5 text-center font-mono text-indigo-700">${totalBoxes} ลัง</td>
        <td class="py-2.5 px-2 text-right font-mono text-rose-700">${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-2 text-right font-mono text-blue-700">${totalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
        <td class="py-2.5 px-2 text-right font-mono text-emerald-700">+${totalProfit.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
      </tr>
    `;
  }
}

async function downloadPurchaseOrderPDF() {
  const sheetEl = document.getElementById('po-report-sheet');
  const btn = document.getElementById('btn-download-po-pdf');
  if (!sheetEl) return;

  if (typeof window.html2pdf === 'undefined') {
    showToast('กำลังเปิดหน้าต่างบันทึก PDF มาตรฐาน...', 'info');
    window.print();
    return;
  }

  const poNum = document.getElementById('po-sheet-number').innerText || 'PO';
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> กำลังสร้างไฟล์ PDF...';
  }

  try {
    const opt = {
      margin: [10, 10, 10, 10],
      filename: `ใบสั่งซื้อไอศกรีม_${poNum}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    await window.html2pdf().set(opt).from(sheetEl).save();
    showToast(`ดาวน์โหลดไฟล์ "ใบสั่งซื้อไอศกรีม_${poNum}.pdf" สำเร็จแล้ว!`, 'success');
  } catch (err) {
    console.error('PDF export error:', err);
    window.print();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function applyPOAsActiveLotCost() {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  if (!activeLot) {
    showToast('ไม่พบลอตปัจจุบันที่เปิดอยู่', 'error');
    return;
  }

  let totalCost = 0;
  let totalRevenue = 0;
  let totalProfit = 0;
  let totalBoxes = 0;
  let totalPieces = 0;
  const items = [];

  for (const p of productCatalog) {
    const qty = parseInt(orderDraftQuantities[p.id] || 0, 10);
    if (qty > 0) {
      const m = computeProductMetrics(p);
      const itemCost = roundMoney(m.boxCost * qty);
      const itemRev = roundMoney(m.boxRevenue * qty);
      const itemProfit = roundMoney(itemRev - itemCost);
      const itemPieces = m.pieces * qty;

      totalCost = roundMoney(totalCost + itemCost);
      totalRevenue = roundMoney(totalRevenue + itemRev);
      totalProfit = roundMoney(totalProfit + itemProfit);
      totalBoxes += qty;
      totalPieces += itemPieces;

      items.push({
        id: p.id,
        name: p.name,
        qty,
        pieces: itemPieces,
        cost: itemCost,
        revenue: itemRev,
        profit: itemProfit
      });
    }
  }

  if (totalCost <= 0 || items.length === 0) {
    showToast('กรุณาเลือกจำนวนลังสินค้าอย่างน้อย 1 ลังก่อนตั้งเป็นต้นทุนลอต', 'warning');
    return;
  }

  if (!confirm(`ต้องการนำยอดรวมใบสั่งซื้อ ฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ไปตั้งเป็นต้นทุนของลอตปัจจุบันใช่หรือไม่?`)) {
    return;
  }

  const savedPayload = saveLotOrderData(activeLot.id, {
    mode: 'catalog',
    quantities: { ...orderDraftQuantities },
    items,
    totalCost,
    totalRevenue,
    totalProfit,
    totalBoxes,
    totalPieces
  });

  const floatAmt = activeLot.float_money !== undefined ? roundMoney(activeLot.float_money) : 500;
  const ok = await updateLotCostAndFloatDB(activeLot.id, totalCost, floatAmt, { order_data: savedPayload });
  if (ok) {
    closeModal('po-report-modal');
    await loadActiveLotData();
    renderActiveLotForecastCard();
    showToast(`ตั้งค่าต้นทุนลอตปัจจุบันเป็น ฿${totalCost.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ตามใบสั่งซื้อเรียบร้อย!`, 'success');
  }
}

function toggleA4SignatureAndDate(show) {
  const dateEl = document.getElementById('a4-report-printed-date');
  const signBlock = document.getElementById('a4-signature-block');
  if (dateEl) dateEl.classList.toggle('hidden', !show);
  if (signBlock) signBlock.classList.toggle('hidden', !show);
}

function togglePOSignatureAndDate(show) {
  const dateRow = document.getElementById('po-date-row');
  const buyerEl = document.getElementById('po-sheet-buyer');
  const signBlock = document.getElementById('po-signature-block');
  if (dateRow) dateRow.classList.toggle('hidden', !show);
  if (buyerEl) buyerEl.classList.toggle('hidden', !show);
  if (signBlock) signBlock.classList.toggle('hidden', !show);
}

// --- Wall's Brand Flavor Packaging Badges & Chime Bell Synthesizer ---
function getWallsFlavorBadge(prod) {
  const name = (prod.name || '').toLowerCase();
  const cat = prod.category || 'ทั่วไป';

  if (cat === 'แพดเดิลป๊อป' || name.includes('แพดเดิลป๊อป') || name.includes('paddle') || name.includes('ป๊อป') || name.includes('เจลลี่')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-pink-500 via-amber-400 to-sky-500 text-white font-extrabold shadow-xs">🦁🌈 Paddle Pop</span>`;
  }
  if (cat === 'คอร์นเนตโต' || name.includes('คอร์เนตโต') || name.includes('cornetto')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-rose-600 to-blue-700 text-white font-bold shadow-xs">🍦 Cornetto โคน</span>`;
  }
  if (cat === 'แม็กนั่ม' || name.includes('แม็กนั่ม') || name.includes('magnum')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-900 via-yellow-800 to-amber-600 text-amber-100 font-bold border border-amber-400/50 shadow-xs">🍫✨ Magnum ช็อกแท้</span>`;
  }
  if (cat === 'เอเชียน ดีไลท์' || name.includes('เอเชียน') || name.includes('กะทิ') || name.includes('ทุเรียน')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold">🥥🌿 Asian Delight</span>`;
  }
  if (cat === 'วอลล์คัพ' || name.includes('ถ้วย')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-pink-100 text-pink-700 border border-pink-200 font-bold">🍨🍓 Wall's Cup ถ้วย</span>`;
  }
  if (cat === 'กล่องตัก/ดีลักซ์') {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold">📦 กล่องตัก/ดีลักซ์</span>`;
  }
  if (name.includes('ท็อปเท็น') || name.includes('top ten')) {
    return `<span class="inline-flex items-center gap-1 text-[10px] px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-bold">🥜🍫 Top Ten</span>`;
  }

  return `<span class="inline-block text-[10px] px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold">🍦 วอลล์</span>`;
}

let wallsSoundEnabled = localStorage.getItem('walls_sound_enabled') !== 'false';

function toggleWallsSound() {
  wallsSoundEnabled = !wallsSoundEnabled;
  localStorage.setItem('walls_sound_enabled', wallsSoundEnabled ? 'true' : 'false');

  const iconEl = document.getElementById('sound-toggle-icon');
  const textEl = document.getElementById('sound-toggle-text');
  const btnEl = document.getElementById('btn-sound-toggle');

  if (wallsSoundEnabled) {
    if (iconEl) iconEl.className = 'fa-solid fa-bell walls-bell-anim';
    if (textEl) textEl.innerText = 'เสียงกริ๊ง';
    if (btnEl) btnEl.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-white/15 hover:bg-white/25 text-amber-200 border border-white/25 transition cursor-pointer whitespace-nowrap shrink-0';
    playWallsChime('success');
    showToast('🔔 เปิดเสียงกระดิ่งรถไอศกรีมวอลล์แล้ว!', 'info');
  } else {
    if (iconEl) iconEl.className = 'fa-solid fa-bell-slash opacity-70';
    if (textEl) textEl.innerText = 'ปิดเสียง';
    if (btnEl) btnEl.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/80 border border-white/20 transition cursor-pointer whitespace-nowrap shrink-0';
    showToast('🔕 ปิดเสียงกระดิ่งเรียบร้อย', 'info');
  }
}

function playWallsChime(type = 'success') {
  if (!wallsSoundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (type === 'tap') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
      return;
    }

    // Wall's Cheerful 4-Note Ice Cream Chime Melody (E5 -> G5 -> C6 -> E6)
    const notes = [659.25, 783.99, 1046.50, 1318.51];
    notes.forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.14, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch (e) {}
}

// ========================================================
// 7. Utility Functions
// ========================================================
function generateUUID() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bgColors = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    warning: 'bg-amber-500 text-slate-900 font-bold',
    info: 'bg-slate-800 text-white'
  };

  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };

  toast.className = `${bgColors[type] || bgColors.info} px-4 py-3 rounded-2xl shadow-xl flex items-center space-x-2.5 text-xs transition-all transform duration-300 -translate-y-2 opacity-0 pointer-events-auto border border-white/10`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-base"></i>
    <span class="flex-1 font-medium">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('-translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// Beautiful Custom Confirmation Dialog Modal (Promise-based)
function showConfirmDialog({
  title = 'ยืนยันการทำรายการ?',
  message = 'คุณแน่ใจหรือไม่ว่าต้องการดำเนินการนี้',
  confirmText = 'ยืนยัน',
  cancelText = 'ยกเลิก',
  type = 'danger', // 'danger' | 'warning' | 'info'
  icon = 'fa-trash-can'
} = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    if (!modal) {
      resolve(confirm(`${title}\n\n${message}`));
      return;
    }

    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-message');
    const iconContainer = document.getElementById('confirm-modal-icon-container');
    const iconEl = document.getElementById('confirm-modal-icon');
    const btnConfirm = document.getElementById('confirm-modal-btn-confirm');
    const btnCancel = document.getElementById('confirm-modal-btn-cancel');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    if (iconEl) iconEl.className = `fa-solid ${icon}`;

    if (iconContainer && btnConfirm) {
      if (type === 'danger') {
        iconContainer.className = 'w-14 h-14 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center text-2xl mx-auto shadow-inner';
        btnConfirm.className = 'flex-1 py-2.5 px-4 bg-rose-600 hover:bg-rose-700 active:scale-95 text-white font-bold rounded-xl text-xs shadow-md transition cursor-pointer';
      } else if (type === 'warning') {
        iconContainer.className = 'w-14 h-14 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center text-2xl mx-auto shadow-inner';
        btnConfirm.className = 'flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 active:scale-95 text-slate-900 font-bold rounded-xl text-xs shadow-md transition cursor-pointer';
      } else {
        iconContainer.className = 'w-14 h-14 rounded-2xl bg-blue-100 text-blue-600 flex items-center justify-center text-2xl mx-auto shadow-inner';
        btnConfirm.className = 'flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold rounded-xl text-xs shadow-md transition cursor-pointer';
      }
    }

    if (btnConfirm) btnConfirm.innerText = confirmText;
    if (btnCancel) btnCancel.innerText = cancelText;

    const cleanup = () => {
      modal.classList.add('hidden');
      btnConfirm.onclick = null;
      btnCancel.onclick = null;
      document.removeEventListener('keydown', keyHandler);
    };

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(false);
      }
    };
    document.addEventListener('keydown', keyHandler);

    btnConfirm.onclick = () => {
      cleanup();
      resolve(true);
    };

    btnCancel.onclick = () => {
      cleanup();
      resolve(false);
    };

    modal.classList.remove('hidden');
  });
}


// ========================================================
// 8. Profit Ledger & School Fund Management (สมุดบัญชีกำไร & กองทุนโรงเรียน)
// ========================================================

let profitLedgerWithdrawals = [];

// Thai Number-to-Words Converter for Official Payment Vouchers (BahtText)
function bahtText(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  num = parseFloat(num);
  if (num === 0) return 'ศูนย์บาทถ้วน';

  const numbers = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const units = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน'];

  function convertInteger(s) {
    let result = '';
    const len = s.length;
    const totalVal = parseInt(s, 10);
    for (let i = 0; i < len; i++) {
      const digit = parseInt(s.charAt(i), 10);
      const pos = len - i - 1;
      if (digit !== 0) {
        if (pos === 1 && digit === 1) {
          result += 'สิบ';
        } else if (pos === 1 && digit === 2) {
          result += 'ยี่สิบ';
        } else if (pos === 0 && digit === 1 && totalVal > 1) {
          result += 'เอ็ด';
        } else {
          result += numbers[digit] + units[pos];
        }
      }
    }
    return result;
  }

  const parts = num.toFixed(2).split('.');
  const integerPart = parts[0];
  const satangPart = parts[1];

  let text = '';
  if (integerPart.length > 6) {
    const millions = integerPart.slice(0, integerPart.length - 6);
    const rest = integerPart.slice(integerPart.length - 6);
    text += convertInteger(millions) + 'ล้าน' + convertInteger(rest) + 'บาท';
  } else if (parseInt(integerPart, 10) > 0) {
    text += convertInteger(integerPart) + 'บาท';
  }

  if (parseInt(satangPart, 10) === 0) {
    text += 'ถ้วน';
  } else {
    text += convertInteger(satangPart) + 'สตางค์';
  }

  return text;
}

// Data Layer: Withdrawals
async function fetchWithdrawals() {
  cleanUpLegacyTestWithdrawalsOnce();
  const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_WITHDRAWALS) || '[]');

  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('withdrawals')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && Array.isArray(data)) {
        // Auto-migrate any real local withdrawals to cloud if cloud table is newly created and empty
        if (data.length === 0 && local.length > 0 && !(typeof isDirectorViewMode === 'function' && isDirectorViewMode())) {
          try {
            const { error: migErr } = await supabaseClient.from('withdrawals').insert(local);
            if (!migErr) {
              profitLedgerWithdrawals = local;
              return local;
            }
          } catch (mErr) {}
        }
        profitLedgerWithdrawals = data;
        localStorage.setItem(STORAGE_KEYS.LOCAL_WITHDRAWALS, JSON.stringify(data));
        return data;
      }
    } catch (e) {
      console.warn('Supabase withdrawals table query warning (fallback to local storage):', e);
    }
  }

  profitLedgerWithdrawals = local;
  return local;
}

async function insertWithdrawal(record) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return null;
  record.amount = roundMoney(record.amount);

  const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_WITHDRAWALS) || '[]');
  local.unshift(record);
  localStorage.setItem(STORAGE_KEYS.LOCAL_WITHDRAWALS, JSON.stringify(local));
  profitLedgerWithdrawals = local;

  if (!isOfflineMode && supabaseClient) {
    try {
      await supabaseClient.from('withdrawals').insert([record]);
    } catch (e) {
      console.warn('Could not insert withdrawal to Supabase, saved locally:', e);
    }
  }
  return record;
}

async function deleteWithdrawalById(id) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  let local = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_WITHDRAWALS) || '[]');
  local = local.filter(w => w.id !== id);
  localStorage.setItem(STORAGE_KEYS.LOCAL_WITHDRAWALS, JSON.stringify(local));
  profitLedgerWithdrawals = local;

  if (!isOfflineMode && supabaseClient) {
    try {
      await supabaseClient.from('withdrawals').delete().eq('id', id);
    } catch (e) {
      console.warn('Could not delete withdrawal from Supabase, removed locally:', e);
    }
  }
}

// ==========================================
// DIRECTOR VIEW-ONLY MODE (โหมดผู้บริหาร / ดูอย่างเดียว)
// ==========================================

function isDirectorViewMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'director' || params.get('mode') === 'readonly';
  } catch (e) {
    return false;
  }
}

function copyDirectorLink() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'director');
    const fullUrl = url.href;

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(fullUrl).then(() => {
        showToast('คัดลอกลิงก์สำหรับ ผอ. เรียบร้อยแล้ว! (ส่งต่อทาง LINE ได้ทันที)', 'success');
      }).catch(() => {
        prompt('คัดลอกลิงก์นี้ส่งให้ ผอ. ดูเฉพาะประวัติและสมุดบัญชี:', fullUrl);
      });
    } else {
      prompt('คัดลอกลิงก์นี้ส่งให้ ผอ. ดูเฉพาะประวัติและสมุดบัญชี:', fullUrl);
    }
  } catch (e) {
    alert('เกิดข้อผิดพลาดในการสร้างลิงก์');
  }
}

function applyDirectorViewMode() {
  if (!isDirectorViewMode()) return;

  // 1. Hide Admin/Input tabs in Desktop Nav
  ['desk-nav-dashboard', 'desk-nav-input', 'desk-nav-products'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  // 2. Hide Admin/Input tabs in Mobile Nav
  ['nav-btn-dashboard', 'nav-btn-input', 'nav-btn-products'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  // 3. Hide Sound toggle and Change Database Settings gear to Director Badge
  const soundBtn = document.getElementById('btn-sound-toggle');
  if (soundBtn) soundBtn.classList.add('hidden');

  const dbBadge = document.getElementById('db-status-badge');
  if (dbBadge) {
    dbBadge.onclick = null;
    dbBadge.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 whitespace-nowrap shrink-0 pointer-events-none shadow-xs';
    dbBadge.innerHTML = '<span id="director-sync-dot" class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse transition-transform duration-300"></span><span>โหมดผู้บริหาร • อัปเดตสด</span>';
  }

  // 4. Hide Share Button, Visit Status Badge, and Withdraw buttons in Profit tab
  const shareBtn = document.getElementById('btn-share-director');
  if (shareBtn) shareBtn.classList.add('hidden');

  const visitStatusBtn = document.getElementById('btn-director-visit-status');
  if (visitStatusBtn) visitStatusBtn.classList.add('hidden');

  document.querySelectorAll('button[onclick*="openWithdrawModal"]').forEach(btn => {
    btn.classList.add('hidden');
  });

  // 5. Hide Close Lot button in History tab
  const btnCloseLot = document.getElementById('btn-close-lot');
  if (btnCloseLot) btnCloseLot.classList.add('hidden');

  // 6. Default to profit tab
  switchTab('profit');
}

// ==========================================
// DIRECTOR VISIT TRACKING & HISTORY (เฉพาะคุณครูเห็นเท่านั้น)
// ==========================================
function detectVisitorDeviceLabel(ua = navigator.userAgent || '') {
  const s = String(ua);
  const isLine = /Line\//i.test(s);
  const browserSuffix = isLine
    ? ' (LINE Browser)'
    : /Edg\//i.test(s)
      ? ' (Edge)'
      : /Chrome\//i.test(s) && !/Chromium/i.test(s)
        ? ' (Chrome)'
        : /Safari\//i.test(s) && !/Chrome\//i.test(s)
          ? ' (Safari)'
          : '';

  if (/iPad/i.test(s) || (/Macintosh/i.test(s) && navigator.maxTouchPoints > 1)) {
    return `📲 iPad / แท็บเล็ต${browserSuffix}`;
  }
  if (/iPhone/i.test(s)) {
    return `📱 มือถือ iPhone${browserSuffix}`;
  }
  if (/Android/i.test(s)) {
    return /Mobile/i.test(s) ? `📱 มือถือ Android${browserSuffix}` : `📲 แท็บเล็ต Android${browserSuffix}`;
  }
  if (/Windows/i.test(s)) {
    return `💻 คอมพิวเตอร์ Windows${browserSuffix}`;
  }
  if (/Macintosh|Mac OS X/i.test(s)) {
    return `💻 คอมพิวเตอร์ Mac${browserSuffix}`;
  }
  return `🌐 อุปกรณ์เว็บ${browserSuffix}`;
}

async function recordDirectorVisitActivity(tabLabel = null) {
  if (!isDirectorViewMode()) return;
  try {
    const SESSION_KEY = 'walls_director_visit_session_v1';
    const nowIso = new Date().toISOString();
    let sessionObj = null;

    try {
      const rawSession = sessionStorage.getItem(SESSION_KEY);
      if (rawSession) sessionObj = JSON.parse(rawSession);
    } catch (e) {}

    // Start a new session if none exists or if older than 30 minutes
    const isExpired = !sessionObj || !sessionObj.last_active_at || (Date.now() - new Date(sessionObj.last_active_at).getTime() > 30 * 60 * 1000);

    if (isExpired) {
      sessionObj = {
        id: generateUUID(),
        visited_at: nowIso,
        last_active_at: nowIso,
        device_label: detectVisitorDeviceLabel(),
        viewed_tabs: tabLabel || 'สมุดบัญชีกำไร',
        user_agent: (navigator.userAgent || '').slice(0, 250)
      };
    } else {
      sessionObj.last_active_at = nowIso;
      if (tabLabel) {
        const currentTabs = (sessionObj.viewed_tabs || '')
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);
        if (!currentTabs.includes(tabLabel)) {
          currentTabs.push(tabLabel);
          sessionObj.viewed_tabs = currentTabs.join(', ');
        }
      }
    }

    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionObj));
    } catch (e) {}

    // Save to localStorage fallback
    const localList = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_DIRECTOR_VISITS) || '[]');
    const existingIdx = localList.findIndex(v => v.id === sessionObj.id);
    if (existingIdx !== -1) {
      localList[existingIdx] = sessionObj;
    } else {
      localList.unshift(sessionObj);
    }
    localStorage.setItem(STORAGE_KEYS.LOCAL_DIRECTOR_VISITS, JSON.stringify(localList.slice(0, 100)));

    // Sync to Supabase director_visits table if online
    if (!isOfflineMode && supabaseClient) {
      try {
        await supabaseClient.from('director_visits').upsert([sessionObj]);
      } catch (e) {}
    }
  } catch (err) {}
}

async function fetchDirectorVisits() {
  const localList = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_DIRECTOR_VISITS) || '[]');
  if (!isOfflineMode && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('director_visits')
        .select('*')
        .order('visited_at', { ascending: false })
        .limit(100);
      if (!error && Array.isArray(data)) {
        if (data.length === 0 && localList.length > 0) {
          try {
            await supabaseClient.from('director_visits').upsert(localList);
            return localList;
          } catch (e) {}
        }
        localStorage.setItem(STORAGE_KEYS.LOCAL_DIRECTOR_VISITS, JSON.stringify(data));
        return data;
      }
    } catch (e) {}
  }
  return localList.sort((a, b) => new Date(b.visited_at) - new Date(a.visited_at));
}

function formatVisitRelativeDateTime(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '-';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const timeStr = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  if (isToday) return `วันนี้ ${timeStr} น.`;
  if (isYesterday) return `เมื่อวาน ${timeStr} น.`;
  const dateStr = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  return `${dateStr} เวลา ${timeStr} น.`;
}

async function renderDirectorVisitStatusBadge() {
  const btn = document.getElementById('btn-director-visit-status');
  if (!btn) return;

  if (isDirectorViewMode()) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');

  const dotEl = document.getElementById('dir-visit-badge-dot');
  const textEl = document.getElementById('dir-visit-badge-text');
  if (!dotEl || !textEl) return;

  const visits = await fetchDirectorVisits();
  if (!visits || visits.length === 0) {
    dotEl.className = 'w-2 h-2 rounded-full bg-slate-400 shrink-0';
    textEl.innerText = '👁️ ยังไม่มีการเปิดดู';
    btn.className = 'px-3 py-2 rounded-xl bg-slate-900/45 hover:bg-slate-900/70 active:scale-95 text-emerald-100 font-semibold text-[11px] border border-white/20 backdrop-blur-xs transition flex items-center space-x-1.5 cursor-pointer shadow-xs';
    return;
  }

  const latest = visits[0];
  const lastActiveTime = new Date(latest.last_active_at || latest.visited_at).getTime();
  const isOnlineNow = (Date.now() - lastActiveTime) <= 90 * 1000; // active within 90 seconds

  if (isOnlineNow) {
    dotEl.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping shrink-0';
    textEl.innerText = `🟢 ผอ. กำลังเปิดดูรายงานอยู่ตอนนี้! (ดูแล้ว ${visits.length} ครั้ง)`;
    btn.className = 'px-3 py-2 rounded-xl bg-emerald-950/90 hover:bg-emerald-900 active:scale-95 text-emerald-200 font-extrabold text-[11px] border-2 border-emerald-400/70 backdrop-blur-xs transition flex items-center space-x-2 cursor-pointer shadow-md';
  } else {
    const lastStr = formatVisitRelativeDateTime(latest.last_active_at || latest.visited_at);
    dotEl.className = 'w-2 h-2 rounded-full bg-teal-300 shrink-0';
    textEl.innerText = `👁️ เปิดดูล่าสุด: ${lastStr} (ดูแล้ว ${visits.length} ครั้ง)`;
    btn.className = 'px-3 py-2 rounded-xl bg-slate-900/55 hover:bg-slate-900/80 active:scale-95 text-emerald-100 font-bold text-[11px] border border-emerald-300/35 backdrop-blur-xs transition flex items-center space-x-1.5 cursor-pointer shadow-xs';
  }
}

async function openDirectorVisitHistoryModal() {
  if (isDirectorViewMode()) return;
  const modal = document.getElementById('director-visit-history-modal');
  if (modal) modal.classList.remove('hidden');
  await refreshDirectorVisitModal();
}

async function refreshDirectorVisitModal() {
  if (isDirectorViewMode()) return;
  const tbody = document.getElementById('dir-visit-tbody');
  const countEl = document.getElementById('dir-visit-total-count');
  const lastTimeEl = document.getElementById('dir-visit-last-time');
  const liveStatusEl = document.getElementById('dir-visit-live-status');

  const visits = await fetchDirectorVisits();
  await renderDirectorVisitStatusBadge();

  if (countEl) countEl.innerText = `${visits.length} ครั้ง`;

  if (!visits || visits.length === 0) {
    if (lastTimeEl) lastTimeEl.innerText = 'ยังไม่มีข้อมูล';
    if (liveStatusEl) {
      liveStatusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-300"></span><span class="text-slate-500">ยังไม่มีผู้เข้าชม</span>`;
    }
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="py-10 text-center text-slate-400">
            <i class="fa-regular fa-eye-slash text-2xl mb-2 block text-slate-300"></i>
            ยังไม่มีประวัติการเปิดดูลิงก์ผู้บริหาร (?view=director)
          </td>
        </tr>
      `;
    }
    return;
  }

  const latest = visits[0];
  const latestActiveMs = new Date(latest.last_active_at || latest.visited_at).getTime();
  const isOnlineNow = (Date.now() - latestActiveMs) <= 90 * 1000;

  if (lastTimeEl) {
    lastTimeEl.innerText = formatVisitRelativeDateTime(latest.last_active_at || latest.visited_at);
  }
  if (liveStatusEl) {
    if (isOnlineNow) {
      liveStatusEl.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span><span class="text-emerald-700 font-black">กำลังเปิดดูอยู่ตอนนี้!</span>`;
    } else {
      liveStatusEl.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span><span class="text-slate-600">ปิดหน้าจอไปแล้ว</span>`;
    }
  }

  if (tbody) {
    tbody.innerHTML = visits.map((v, idx) => {
      const seqNum = visits.length - idx;
      const startObj = new Date(v.visited_at);
      const endObj = new Date(v.last_active_at || v.visited_at);
      const isRowOnline = idx === 0 && (Date.now() - endObj.getTime()) <= 90 * 1000;

      const fullDateStr = startObj.toLocaleDateString('th-TH', {
        day: 'numeric',
        month: 'short',
        year: '2-digit'
      });
      const startTimeStr = startObj.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      const durationMin = Math.max(1, Math.round((endObj.getTime() - startObj.getTime()) / 60000));
      const durationBadge = isRowOnline
        ? `<span class="ml-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">🟢 กำลังดูอยู่</span>`
        : (endObj.getTime() - startObj.getTime() > 45000
          ? `<span class="text-[10px] text-slate-400 block">เปิดดูนาน ~${durationMin} นาที</span>`
          : '');

      const tabsArr = String(v.viewed_tabs || 'สมุดบัญชีกำไร')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      const tabsBadgesHtml = tabsArr.map(t => {
        const isProfit = t.includes('กำไร') || t.includes('สมุด');
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold ${isProfit ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}">${isProfit ? '📗' : '📜'} ${escapeHtml(t)}</span>`;
      }).join(' ');

      return `
        <tr class="${isRowOnline ? 'bg-emerald-50/50' : 'hover:bg-slate-50/80'} transition">
          <td class="py-3 px-3 text-center font-mono font-bold text-slate-500">
            #${seqNum}
          </td>
          <td class="py-3 px-3 whitespace-nowrap">
            <div class="font-bold text-slate-800 flex items-center flex-wrap">
              <span>${fullDateStr} เวลา ${startTimeStr} น.</span>
              ${durationBadge}
            </div>
            <span class="text-[10px] text-slate-400">${formatVisitRelativeDateTime(v.visited_at)}</span>
          </td>
          <td class="py-3 px-3 font-semibold text-slate-700">
            ${escapeHtml(v.device_label || 'ไม่ระบุอุปกรณ์')}
          </td>
          <td class="py-3 px-3">
            <div class="flex items-center gap-1 flex-wrap">
              ${tabsBadgesHtml}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }
}

async function clearDirectorVisitHistory() {
  if (isDirectorViewMode()) return;
  const confirmed = await showConfirmDialog({
    title: 'ยืนยันล้างประวัติการเข้าชมของ ผอ.?',
    message: 'ประวัติการเปิดดูลิงก์ผู้บริหารทั้งหมดจะถูกล้างและเริ่มนับ 0 ใหม่',
    confirmText: 'ล้างประวัติ',
    cancelText: 'ยกเลิก',
    type: 'danger',
    icon: 'fa-trash-can'
  });
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEYS.LOCAL_DIRECTOR_VISITS);
  if (!isOfflineMode && supabaseClient) {
    try {
      await supabaseClient.from('director_visits').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    } catch (e) {}
  }

  await refreshDirectorVisitModal();
  showToast('ล้างประวัติการเข้าชมลิงก์ผู้บริหารเรียบร้อยแล้ว', 'info');
}

// ==========================================
// AUTO-REFRESH & LIVE SYNC SYSTEM (ระบบอัปเดตข้อมูลอัตโนมัติ)
// ==========================================
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL_MS = 30000; // 30 seconds

function initAutoRefreshSystem() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);

  // Set periodic polling
  autoRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      performSilentDataSync();
    }
  }, AUTO_REFRESH_INTERVAL_MS);

  // Instant refresh when user/director switches back to the tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      performSilentDataSync();
    }
  });
}

async function performSilentDataSync() {
  try {
    // Attempt auto-reconnect & flush offline queue if needed
    if (isOfflineMode && localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) !== 'local') {
      await tryReconnectAndFlushPending();
    } else if (!isOfflineMode && supabaseClient) {
      await flushPendingSalesQueue();
    }

    // If in Director mode, keep session heartbeat alive while visible
    if (isDirectorViewMode()) {
      await recordDirectorVisitActivity();
    }

    // If any modal is open in Admin mode, avoid interrupting user input
    const isModalOpen = document.querySelector(
      '.modal:not(.hidden), #close-lot-modal:not(.hidden), #withdraw-profit-modal:not(.hidden), #edit-remark-modal:not(.hidden), #active-lot-order-modal:not(.hidden), #edit-cost-modal:not(.hidden), #edit-sale-modal:not(.hidden), #config-modal:not(.hidden), #product-modal:not(.hidden), #director-visit-history-modal:not(.hidden)'
    );
    if (isModalOpen && !isDirectorViewMode()) return;

    // Check which tab is currently active
    const activeTabEl = document.querySelector('.tab-pane:not(.hidden)');
    const activeTabId = activeTabEl ? activeTabEl.id : '';

    if (activeTabId === 'tab-profit') {
      await loadProfitLedgerData();
    } else if (activeTabId === 'tab-history') {
      await loadHistoryData();
    } else if (activeTabId === 'tab-dashboard' && !isDirectorViewMode()) {
      await loadActiveLotData();
    }

    // Flash live sync dot in Director mode
    const syncDot = document.getElementById('director-sync-dot');
    if (syncDot) {
      syncDot.classList.add('scale-150', 'bg-emerald-300');
      setTimeout(() => {
        syncDot.classList.remove('scale-150', 'bg-emerald-300');
      }, 500);
    }
  } catch (err) {
    console.debug('Silent sync skipped or error:', err);
  }
}

// ==========================================
// PROFIT LEDGER (สมุดบัญชีกำไร แบบที่ 1: MASTER CASH BOOK)
// ==========================================

function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getLotNote(lotId) {
  try {
    const map = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_NOTES) || '{}');
    if (map[lotId]) return map[lotId];
    const lotObj = (closedLots || []).find(l => l.id === lotId) || (activeLot && activeLot.id === lotId ? activeLot : null);
    if (lotObj && typeof lotObj.lot_note === 'string') return lotObj.lot_note;
    return '';
  } catch (e) {
    return '';
  }
}

async function saveLotNote(lotId, note) {
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  try {
    const cleanNote = (note || '').trim();
    const map = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_LOT_NOTES) || '{}');
    if (cleanNote) {
      map[lotId] = cleanNote;
    } else {
      delete map[lotId];
    }
    localStorage.setItem(STORAGE_KEYS.LOCAL_LOT_NOTES, JSON.stringify(map));

    if (!isOfflineMode && supabaseClient) {
      try {
        await supabaseClient.from('lots').update({ lot_note: cleanNote }).eq('id', lotId);
      } catch (e) {}
    }
  } catch (e) {
    console.error('Failed to save lot note:', e);
  }
}

// Edit Remark Modal Operations
function openEditRemarkModal(type, id, currentNote, currentRecipient = '') {
  if (isDirectorViewMode()) {
    showToast('โหมดผู้บริหาร: สำหรับดูข้อมูลอย่างเดียว ไม่สามารถแก้ไขได้', 'warning');
    return;
  }
  const typeEl = document.getElementById('edit-remark-type');
  const idEl = document.getElementById('edit-remark-id');
  const inputEl = document.getElementById('edit-remark-input');
  const labelEl = document.getElementById('edit-remark-input-label');
  const titleEl = document.getElementById('edit-remark-title');
  const subEl = document.getElementById('edit-remark-subtitle');
  const recipientGroup = document.getElementById('edit-remark-recipient-group');
  const recipientInput = document.getElementById('edit-remark-recipient');
  const deleteBtnContainer = document.getElementById('edit-remark-delete-btn-container');

  if (typeEl) typeEl.value = type;
  if (idEl) idEl.value = id;
  if (inputEl) inputEl.value = currentNote || '';

  if (type === 'lot') {
    if (titleEl) titleEl.innerText = 'แก้ไขหมายเหตุงวดการขาย';
    if (subEl) subEl.innerText = 'บันทึกช่วยจำสำหรับงวดนี้';
    if (labelEl) labelEl.innerText = 'ข้อความหมายเหตุ / บันทึกช่วยจำ';
    if (recipientGroup) recipientGroup.classList.add('hidden');
    if (deleteBtnContainer) deleteBtnContainer.classList.add('hidden');
  } else {
    if (titleEl) titleEl.innerText = 'แก้ไขรายการเบิกเงินกำไร';
    if (subEl) subEl.innerText = 'แก้ไขวัตถุประสงค์ หรือชื่อผู้รับเงิน';
    if (labelEl) labelEl.innerText = 'วัตถุประสงค์ / รายละเอียดการเบิก';
    if (recipientGroup) recipientGroup.classList.remove('hidden');
    if (recipientInput) recipientInput.value = currentRecipient || '';
    if (deleteBtnContainer) deleteBtnContainer.classList.remove('hidden');
  }

  const modal = document.getElementById('edit-remark-modal');
  if (modal) modal.classList.remove('hidden');
  if (type === 'withdrawal' && recipientInput) {
    setTimeout(() => {
      recipientInput.focus();
    }, 100);
  } else if (inputEl) {
    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 100);
  }
}

async function handleDeleteFromEditModal() {
  const id = document.getElementById('edit-remark-id')?.value;
  if (!id) return;
  closeModal('edit-remark-modal');
  await handleDeleteWithdrawal(id);
}

async function handleSaveRemark(event) {
  if (event) event.preventDefault();
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;
  const type = document.getElementById('edit-remark-type')?.value;
  const id = document.getElementById('edit-remark-id')?.value;
  const val = document.getElementById('edit-remark-input')?.value.trim() || '';
  const recVal = document.getElementById('edit-remark-recipient')?.value.trim() || '';

  if (type === 'lot') {
    await saveLotNote(id, val);
    showToast('บันทึกหมายเหตุประจำงวดเรียบร้อยแล้ว', 'success');
  } else if (type === 'withdrawal') {
    const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.LOCAL_WITHDRAWALS) || '[]');
    const target = local.find(w => w.id === id);
    if (target) {
      target.purpose = val || 'เบิกเงินกำไรกองทุน';
      if (recVal) target.recipient = recVal;
      localStorage.setItem(STORAGE_KEYS.LOCAL_WITHDRAWALS, JSON.stringify(local));
      profitLedgerWithdrawals = local;
    }
    if (!isOfflineMode && supabaseClient) {
      try {
        const updateObj = { purpose: val || 'เบิกเงินกำไรกองทุน' };
        if (recVal) updateObj.recipient = recVal;
        await supabaseClient.from('withdrawals').update(updateObj).eq('id', id);
      } catch (e) {
        console.warn('Could not update withdrawal in Supabase, updated locally:', e);
      }
    }
    showToast('บันทึกแก้ไขรายการเบิกเงินเรียบร้อยแล้ว', 'success');
  }

  closeModal('edit-remark-modal');
  await loadProfitLedgerData();
}

// Floating Row Actions Dropdown (Idea 1: 3-dot dropdown menu)
function openProfitRowActions(event, type, id, param1, param2) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }

  if (isDirectorViewMode()) return;

  const dropdown = document.getElementById('profit-row-actions-dropdown');
  if (!dropdown) return;

  if (!dropdown.classList.contains('hidden') && dropdown.dataset.activeId === id) {
    closeProfitRowActions();
    return;
  }

  dropdown.dataset.activeId = id;
  const itemsContainer = document.getElementById('profit-dropdown-items');
  const titleContainer = document.getElementById('profit-dropdown-title');

  if (type === 'lot') {
    if (titleContainer) {
      titleContainer.innerHTML = '<span>งวดการขาย (ลอต)</span><i class="fa-solid fa-box-archive text-[10px]"></i>';
    }
    const escapedNote = escapeAttr(param1 || '');
    if (itemsContainer) {
      itemsContainer.innerHTML = `
        <button type="button" onclick="openEditRemarkModal('lot', '${id}', '${escapedNote}'); closeProfitRowActions();" class="w-full text-left px-3.5 py-2 text-slate-700 hover:bg-blue-50 hover:text-blue-700 font-semibold flex items-center gap-2.5 transition cursor-pointer">
          <i class="fa-solid fa-pen text-blue-500 w-4"></i>
          <span>แก้ไขบันทึกช่วยจำ</span>
        </button>
      `;
    }
  } else {
    // Withdrawal
    if (titleContainer) {
      titleContainer.innerHTML = '<span>รายการเบิกกำไร</span><i class="fa-solid fa-receipt text-[10px]"></i>';
    }
    const escapedPurpose = escapeAttr(param1 || '');
    const escapedRecipient = escapeAttr(param2 || '');
    if (itemsContainer) {
      itemsContainer.innerHTML = `
        <button type="button" onclick="openVoucherModal('${id}'); closeProfitRowActions();" class="w-full text-left px-3.5 py-2 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 font-semibold flex items-center gap-2.5 transition cursor-pointer">
          <i class="fa-solid fa-print text-emerald-600 w-4"></i>
          <span>พิมพ์ใบสำคัญจ่าย</span>
        </button>
        <button type="button" onclick="openEditRemarkModal('withdrawal', '${id}', '${escapedPurpose}', '${escapedRecipient}'); closeProfitRowActions();" class="w-full text-left px-3.5 py-2 text-slate-700 hover:bg-blue-50 hover:text-blue-700 font-semibold flex items-center gap-2.5 transition cursor-pointer">
          <i class="fa-solid fa-pen text-blue-500 w-4"></i>
          <span>แก้ไขข้อมูล / ผู้รับเงิน</span>
        </button>
        <button type="button" onclick="handleDeleteWithdrawal('${id}'); closeProfitRowActions();" class="w-full text-left px-3.5 py-2 text-rose-600 hover:bg-rose-50 font-semibold flex items-center gap-2.5 transition cursor-pointer border-t border-slate-100">
          <i class="fa-solid fa-trash-can text-rose-500 w-4"></i>
          <span>ยกเลิก / ลบรายการนี้</span>
        </button>
      `;
    }
  }

  dropdown.classList.remove('hidden');

  const rect = event.currentTarget.getBoundingClientRect();
  const dropdownWidth = 208; // 13rem
  let left = rect.right - dropdownWidth;
  if (left < 10) left = 10;
  let top = rect.bottom + 6;

  // If overflowing below screen, flip upwards
  const dropdownHeight = type === 'lot' ? 70 : 140;
  if (top + dropdownHeight > window.innerHeight) {
    top = Math.max(10, rect.top - dropdownHeight - 6);
  }

  dropdown.style.left = `${left}px`;
  dropdown.style.top = `${top}px`;
}

function closeProfitRowActions() {
  const dropdown = document.getElementById('profit-row-actions-dropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    dropdown.classList.add('hidden');
    dropdown.dataset.activeId = '';
  }
}

// Global click listeners to close dropdown outside
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('profit-row-actions-dropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!dropdown.contains(e.target) && !e.target.closest('button[onclick*="openProfitRowActions"]')) {
      closeProfitRowActions();
    }
  }
});
window.addEventListener('scroll', closeProfitRowActions, true);
window.addEventListener('resize', closeProfitRowActions);

// Master Cash Book Builder: Merges Closed Lots & Withdrawals into a Unified Chronological Ledger
async function buildMasterCashBookRows() {
  const closed = await fetchClosedLotsWithDetails();
  const withdrawals = await fetchWithdrawals();

  // Sort closed lots oldest -> newest to assign sequential "งวดที่ 1", "งวดที่ 2", ...
  const chronologicalClosed = [...closed].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const rows = [];

  // 1. Process closed lots (Income & Supplier Cost)
  chronologicalClosed.forEach((lot, idx) => {
    const lotNumber = idx + 1;
    const rev = parseFloat(lot.total_collected) || 0;
    const cost = parseFloat(lot.cost) || 5000;
    const profit = rev - cost;

    const startObj = new Date(lot.created_at);
    const endObj = lot.closed_at ? new Date(lot.closed_at) : new Date();
    const startStr = startObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const endStr = lot.closed_at
      ? endObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '-';

    const sortDateObj = lot.closed_at ? new Date(lot.closed_at) : new Date(lot.created_at);
    const dateFormatted = sortDateObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });

    rows.push({
      type: 'lot',
      id: lot.id,
      lotNumber,
      lotRef: lot.lot_number || lotNumber,
      dateFormatted,
      dateRange: `${startStr} - ${endStr}`,
      sortTimestamp: sortDateObj.getTime(),
      salesRev: rev,
      distCost: cost,
      netProfit: profit,
      withdrawAmt: 0,
      note: getLotNote(lot.id),
      recipient: "ตัวแทนจำหน่าย Wall's",
      rawDate: lot.closed_at || lot.created_at
    });
  });

  // 2. Process profit withdrawals (Expense from Profit Pool)
  withdrawals.forEach(w => {
    const wDateObj = w.date ? new Date(w.date) : new Date(w.created_at);
    const dateFormatted = wDateObj.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const amt = parseFloat(w.amount) || 0;

    rows.push({
      type: 'withdrawal',
      id: w.id,
      pvNumber: w.pv_number || '',
      dateFormatted,
      sortTimestamp: wDateObj.getTime(),
      salesRev: 0,
      distCost: 0,
      netProfit: 0,
      withdrawAmt: amt,
      purpose: w.purpose || 'เบิกเงินกำไรกองทุน',
      category: w.category || 'ทั่วไป',
      recipient: w.recipient || '-',
      note: w.purpose || '',
      rawDate: w.date || w.created_at
    });
  });

  // Chronological sort: oldest first. If same timestamp, lots come before withdrawals so profit is credited before spent.
  rows.sort((a, b) => {
    if (a.sortTimestamp !== b.sortTimestamp) {
      return a.sortTimestamp - b.sortTimestamp;
    }
    return a.type === 'lot' ? -1 : 1;
  });

  // Compute running balance line-by-line
  let runningProfit = 0;
  let totalSalesRev = 0;
  let totalDistCost = 0;
  let totalNetProfit = 0;
  let totalWithdrawn = 0;

  rows.forEach(r => {
    totalSalesRev += r.salesRev;
    totalDistCost += r.distCost;
    totalNetProfit += r.netProfit;
    totalWithdrawn += r.withdrawAmt;
    runningProfit += (r.netProfit - r.withdrawAmt);
    r.runningBalance = runningProfit;
  });

  return {
    rows,
    closedLotsCount: chronologicalClosed.length,
    withdrawalsCount: withdrawals.length,
    totalSalesRev,
    totalDistCost,
    totalNetProfit,
    totalWithdrawn,
    finalBalance: runningProfit,
    availableBalance: Math.max(0, runningProfit)
  };
}

// Core Profit Ledger Calculation & Rendering
async function loadProfitLedgerData() {
  const data = await buildMasterCashBookRows();
  if (!activeLot) activeLot = await fetchActiveLot();

  const activeCost = activeLot && activeLot.cost !== undefined ? parseFloat(activeLot.cost) : 5000;

  // 1. Update Executive Metrics Cards
  const cardAvail = document.getElementById('profit-card-available');
  if (cardAvail) {
    cardAvail.innerText = `฿${data.availableBalance.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

  const cardEarned = document.getElementById('profit-card-total-earned');
  if (cardEarned) cardEarned.innerText = `฿${data.totalNetProfit.toLocaleString('th-TH')}`;

  const cardWithdrawn = document.getElementById('profit-card-total-withdrawn');
  if (cardWithdrawn) cardWithdrawn.innerText = `฿${data.totalWithdrawn.toLocaleString('th-TH')}`;

  const cardActiveCost = document.getElementById('profit-card-active-cost');
  if (cardActiveCost) cardActiveCost.innerText = `฿${activeCost.toLocaleString('th-TH')}`;

  const cardClosedCount = document.getElementById('profit-card-closed-lots-count');
  if (cardClosedCount) cardClosedCount.innerText = `จากลอตที่ปิดรอบแล้ว ${data.closedLotsCount} งวด`;

  const cardMargin = document.getElementById('profit-card-margin');
  if (cardMargin) {
    const marginPct = data.totalSalesRev > 0 ? ((data.totalNetProfit / data.totalSalesRev) * 100).toFixed(1) : 0;
    cardMargin.innerText = `${marginPct}%`;
  }

  const cardWithdrawnCount = document.getElementById('profit-card-withdrawn-count');
  if (cardWithdrawnCount) cardWithdrawnCount.innerText = `รวม ${data.withdrawalsCount} รายการเบิกจ่าย`;

  const cardVoucherCount = document.getElementById('profit-card-voucher-count');
  if (cardVoucherCount) cardVoucherCount.innerText = `${data.withdrawalsCount} ฉบับ`;

  const badgeLotCount = document.getElementById('profit-lot-count-badge');
  if (badgeLotCount) badgeLotCount.innerText = `${data.closedLotsCount} งวด`;

  const masterBadge = document.getElementById('profit-master-count-badge');
  if (masterBadge) masterBadge.innerText = `${data.rows.length} รายการ`;

  // 2. Render Master Cash Book Table
  const tbody = document.getElementById('profit-master-tbody');
  const tfoot = document.getElementById('profit-master-tfoot');
  const emptyEl = document.getElementById('profit-master-empty');

  if (tbody) {
    if (data.rows.length === 0) {
      tbody.innerHTML = '';
      if (tfoot) tfoot.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
    } else {
      if (emptyEl) emptyEl.classList.add('hidden');

      const isReadOnly = isDirectorViewMode();

      tbody.innerHTML = data.rows.map(row => {
        if (row.type === 'lot') {
          const profitClass = row.netProfit >= 0 ? 'text-emerald-700 font-black' : 'text-rose-600 font-black';
          const escapedNote = escapeAttr(row.note);

          const noteHtml = isReadOnly
            ? `<span class="text-slate-500 italic">${row.note ? escapedNote : '<span class="text-slate-300 font-normal">ไม่มีหมายเหตุ</span>'}</span>`
            : `<span onclick="openEditRemarkModal('lot', '${row.id}', '${escapedNote}')" class="text-slate-500 italic cursor-pointer hover:text-blue-600 transition" title="คลิกเพื่อแก้ไขหมายเหตุ">${row.note ? escapedNote : '<span class="text-slate-300 font-normal">ไม่มีหมายเหตุ</span>'}</span>`;

          const actionHtml = isReadOnly
            ? `<span class="text-slate-300 text-xs">-</span>`
            : `
                <button type="button" onclick="openProfitRowActions(event, 'lot', '${row.id}', '${escapedNote}')" class="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition inline-flex items-center justify-center cursor-pointer border border-transparent hover:border-slate-200" title="ตัวเลือกเพิ่มเติม">
                  <i class="fa-solid fa-ellipsis-vertical text-xs"></i>
                </button>
              `;

          return `
            <tr class="${isReadOnly ? '' : 'group'} hover:bg-slate-50/80 transition">
              <td class="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap text-xs">
                <i class="fa-regular fa-calendar-check text-[10px] mr-1 text-slate-400"></i>${row.dateFormatted}
              </td>
              <td class="py-2.5 px-3">
                <div class="font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
                  <span class="inline-flex items-center justify-center w-5 h-5 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-black font-mono border border-emerald-200">
                    ${row.lotNumber}
                  </span>
                  <span>งวดที่ ${row.lotNumber} (ลอต ${row.lotRef})</span>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">ปิดรอบแล้ว</span>
                </div>
                <div class="text-[11px] text-slate-400 mt-0.5">
                  <i class="fa-regular fa-clock text-[10px] mr-1"></i>ช่วงขาย: ${row.dateRange}
                </div>
              </td>
              <td class="py-2.5 px-2.5 text-right font-mono font-semibold text-blue-700 whitespace-nowrap tabular-nums">
                ฿${row.salesRev.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td class="py-2.5 px-2.5 text-right font-mono font-medium text-rose-600 whitespace-nowrap tabular-nums">
                -฿${row.distCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td class="py-2.5 px-2.5 text-right font-mono ${profitClass} bg-emerald-50/60 whitespace-nowrap tabular-nums">
                +฿${row.netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td class="py-2.5 px-2.5 text-center text-slate-300 whitespace-nowrap">
                -
              </td>
              <td class="py-2.5 px-2.5 text-right font-mono font-extrabold text-slate-900 whitespace-nowrap tabular-nums">
                ฿${row.runningBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td class="py-2.5 px-3 text-xs text-slate-700">
                <div class="space-y-0.5">
                  <div class="text-slate-600 text-[11px] flex items-center gap-1">
                    <i class="fa-solid fa-truck text-[10px] text-slate-400"></i>
                    <span>จ่ายให้: <strong>ตัวแทน Wall's</strong></span>
                  </div>
                  <div class="flex items-center gap-1.5 flex-wrap">
                    ${noteHtml}
                  </div>
                </div>
              </td>
              <td class="py-2.5 px-2 text-center whitespace-nowrap">
                ${actionHtml}
              </td>
            </tr>
          `;
        } else {
          // Withdrawal Row
          const escapedPurpose = escapeAttr(row.purpose);
          const escapedRecipient = escapeAttr(row.recipient);

          const noteHtml = isReadOnly
            ? `<span class="text-slate-600">${escapedPurpose}</span>`
            : `<span onclick="openEditRemarkModal('withdrawal', '${row.id}', '${escapedPurpose}', '${escapedRecipient}')" class="text-slate-600 cursor-pointer hover:text-blue-600 transition" title="คลิกเพื่อแก้ไขวัตถุประสงค์ / ผู้รับเงิน">${escapedPurpose}</span>`;

          const actionHtml = isReadOnly
            ? `
                <button type="button" onclick="openVoucherModal('${row.id}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-[11px] rounded-lg shadow-xs transition inline-flex items-center gap-1 cursor-pointer" title="พิมพ์ใบสำคัญจ่าย">
                  <i class="fa-solid fa-print text-[10px]"></i>
                  <span>พิมพ์</span>
                </button>
              `
            : `
                <div class="inline-flex items-center gap-1.5 justify-center">
                  <button type="button" onclick="openVoucherModal('${row.id}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-[11px] rounded-lg shadow-xs transition inline-flex items-center gap-1 cursor-pointer" title="พิมพ์ใบสำคัญจ่าย">
                    <i class="fa-solid fa-print text-[10px]"></i>
                    <span>พิมพ์</span>
                  </button>
                  <button type="button" onclick="openProfitRowActions(event, 'withdrawal', '${row.id}', '${escapedPurpose}', '${escapedRecipient}')" class="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition inline-flex items-center justify-center cursor-pointer border border-slate-200/80 bg-white shadow-2xs" title="ตัวเลือกเพิ่มเติม">
                    <i class="fa-solid fa-ellipsis-vertical text-xs"></i>
                  </button>
                </div>
              `;

          return `
            <tr class="${isReadOnly ? '' : 'group'} hover:bg-amber-50/40 transition bg-amber-50/20">
              <td class="py-2.5 px-3 font-mono text-slate-700 whitespace-nowrap text-xs">
                <i class="fa-regular fa-calendar-check text-[10px] mr-1 text-slate-400"></i>${row.dateFormatted}
              </td>
              <td class="py-2.5 px-3">
                <div class="font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
                  <span class="inline-flex items-center justify-center w-5 h-5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-black border border-amber-200">
                    <i class="fa-solid fa-receipt"></i>
                  </span>
                  <span class="text-rose-700 font-black">เบิกกำไร: ${escapedPurpose}</span>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">${row.category || 'ทั่วไป'}</span>
                </div>
                <div class="text-[11px] text-slate-500 mt-0.5">
                  <i class="fa-solid fa-user text-[10px] mr-1 text-slate-400"></i>ผู้ขอเบิก: <strong class="text-slate-700">${escapedRecipient}</strong>
                </div>
              </td>
              <td class="py-2.5 px-2.5 text-center text-slate-300 whitespace-nowrap">
                -
              </td>
              <td class="py-2.5 px-2.5 text-center text-slate-300 whitespace-nowrap">
                -
              </td>
              <td class="py-2.5 px-2.5 text-center text-slate-300 whitespace-nowrap">
                -
              </td>
              <td class="py-2.5 px-2.5 text-right font-mono font-black text-rose-600 bg-rose-50/50 whitespace-nowrap tabular-nums">
                -฿${row.withdrawAmt.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td class="py-2.5 px-2.5 text-right font-mono font-extrabold text-slate-900 whitespace-nowrap tabular-nums">
                ฿${row.runningBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td class="py-2.5 px-3 text-xs text-slate-700">
                <div class="space-y-0.5">
                  <div class="text-slate-600 text-[11px]">
                    ผู้รับเงิน: <strong class="text-slate-800">${escapedRecipient}</strong>
                  </div>
                  <div class="flex items-center gap-1.5 flex-wrap">
                    ${noteHtml}
                  </div>
                </div>
              </td>
              <td class="py-2.5 px-2 text-center whitespace-nowrap">
                ${actionHtml}
              </td>
            </tr>
          `;
        }
      }).join('');

      if (isReadOnly) {
        document.querySelectorAll('button[onclick*="openWithdrawModal"]').forEach(btn => btn.classList.add('hidden'));
        const shareBtn = document.getElementById('btn-share-director');
        if (shareBtn) shareBtn.classList.add('hidden');
        const visitStatusBtn = document.getElementById('btn-director-visit-status');
        if (visitStatusBtn) visitStatusBtn.classList.add('hidden');
      }

      if (tfoot) {
        tfoot.innerHTML = `
          <tr class="bg-slate-100/90 text-slate-900 border-t-2 border-slate-300">
            <td colspan="2" class="py-3 px-3 text-right font-black">
              รวมทุกรายการทั้งสิ้น
            </td>
            <td class="py-3 px-2.5 text-right font-mono font-bold text-blue-700 whitespace-nowrap tabular-nums">
              ฿${data.totalSalesRev.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="py-3 px-2.5 text-right font-mono font-bold text-rose-700 whitespace-nowrap tabular-nums">
              -฿${data.totalDistCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="py-3 px-2.5 text-right font-mono font-black text-emerald-800 bg-emerald-100/70 whitespace-nowrap tabular-nums">
              +฿${data.totalNetProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="py-3 px-2.5 text-right font-mono font-black text-rose-700 bg-rose-50/70 whitespace-nowrap tabular-nums">
              -฿${data.totalWithdrawn.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="py-3 px-2.5 text-right font-mono font-black text-sm text-emerald-700 bg-emerald-50 whitespace-nowrap tabular-nums">
              ฿${data.finalBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td colspan="2" class="py-3 px-3 text-[11px] text-slate-500 font-normal">
              (กำไรสะสมคงเหลือพร้อมเบิก)
            </td>
          </tr>
        `;
      }
    }
  }

  // Update Director visit status pill on teacher's Profit Ledger header
  await renderDirectorVisitStatusBadge();
}

// Withdrawal Modal Operations
async function openWithdrawModal() {
  if (isDirectorViewMode()) {
    showToast('โหมดผู้บริหาร: สำหรับดูข้อมูลอย่างเดียว ไม่สามารถทำรายการเบิกเงินได้', 'warning');
    return;
  }
  const data = await buildMasterCashBookRows();

  if (data.availableBalance <= 0) {
    showToast('ขณะนี้ยังไม่มีกำไรสะสมคงเหลือสำหรับเบิกจ่าย (ต้องปิดลอตที่มีกำไรก่อน)', 'warning');
    return;
  }

  const availEl = document.getElementById('withdraw-modal-available-text');
  if (availEl) {
    availEl.innerText = `฿${data.availableBalance.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

  const todayIso = getLocalDateISO();
  const dateInput = document.getElementById('withdraw-date');
  if (dateInput) dateInput.value = todayIso;

  const amountInput = document.getElementById('withdraw-amount');
  if (amountInput) {
    amountInput.value = '';
    amountInput.max = data.availableBalance;
  }

  const errEl = document.getElementById('withdraw-error-msg');
  if (errEl) errEl.classList.add('hidden');

  const btnSubmit = document.getElementById('btn-submit-withdrawal');
  if (btnSubmit) btnSubmit.disabled = false;

  document.getElementById('withdraw-profit-modal').classList.remove('hidden');
}

function setWithdrawAmount(val) {
  const amountInput = document.getElementById('withdraw-amount');
  if (amountInput) {
    amountInput.value = val;
    validateWithdrawAmountInput();
  }
}

async function setWithdrawAmountMax() {
  const data = await buildMasterCashBookRows();
  const amountInput = document.getElementById('withdraw-amount');
  if (amountInput) {
    amountInput.value = data.availableBalance;
    validateWithdrawAmountInput();
  }
}

async function validateWithdrawAmountInput() {
  const amountInput = document.getElementById('withdraw-amount');
  const errEl = document.getElementById('withdraw-error-msg');
  const btnSubmit = document.getElementById('btn-submit-withdrawal');
  if (!amountInput) return;

  const val = parseFloat(amountInput.value) || 0;
  const max = parseFloat(amountInput.max) || 0;

  if (val > max) {
    if (errEl) errEl.classList.remove('hidden');
    if (btnSubmit) btnSubmit.disabled = true;
  } else {
    if (errEl) errEl.classList.add('hidden');
    if (btnSubmit) btnSubmit.disabled = false;
  }
}

async function handleConfirmWithdrawal(event) {
  if (event) event.preventDefault();
  if (typeof isDirectorViewMode === 'function' && isDirectorViewMode()) return;

  const amountVal = roundMoney(document.getElementById('withdraw-amount')?.value || 0);
  if (amountVal <= 0) {
    alert('กรุณาระบุจำนวนเงินที่ต้องการเบิกมากกว่า 0 บาท');
    return;
  }

  const data = await buildMasterCashBookRows();
  if (amountVal > data.availableBalance) {
    alert(`จำนวนเงินที่ต้องการเบิก (฿${amountVal.toLocaleString()}) เกินกว่ากำไรสะสมคงเหลือ (฿${data.availableBalance.toLocaleString()})`);
    return;
  }

  const dateVal = document.getElementById('withdraw-date')?.value || getLocalDateISO();
  const earliestLotRow = data.rows.find(r => r.type === 'lot');
  if (earliestLotRow && new Date(dateVal).getTime() < earliestLotRow.sortTimestamp - 86400000) {
    const proceedBackdate = confirm('⚠️ วันที่เบิกเงินย้อนหลังไปก่อนวันที่ปิดลอตแรก อาจทำให้ยอดคงเหลือรายบรรทัดติดลบชั่วคราว ยืนยันใช้วันที่นี้หรือไม่?');
    if (!proceedBackdate) return;
  }

  const categoryVal = document.getElementById('withdraw-category')?.value || 'กิจกรรมโรงเรียน';
  const purposeVal = document.getElementById('withdraw-purpose')?.value.trim() || 'เบิกเงินกำไรกองทุนโครงการ';
  const recipientVal = document.getElementById('withdraw-recipient')?.value.trim() || 'ผู้ขอเบิก';
  const approverVal = document.getElementById('withdraw-approver')?.value?.trim() || 'ผู้อำนวยการโรงเรียน';

  const pvNo = generateNextPvNumber(dateVal, profitLedgerWithdrawals);

  const newWithdrawal = {
    id: generateUUID(),
    pv_number: pvNo,
    date: dateVal,
    amount: amountVal,
    category: categoryVal,
    purpose: purposeVal,
    recipient: recipientVal,
    approver: approverVal,
    lot_id: null,
    created_at: new Date().toISOString()
  };

  await insertWithdrawal(newWithdrawal);
  closeModal('withdraw-profit-modal');
  showToast(`บันทึกเบิกเงิน ฿${amountVal.toLocaleString()} สำเร็จแล้ว!`, 'success');

  await loadProfitLedgerData();
  openVoucherModal(newWithdrawal.id);
}

async function handleDeleteWithdrawal(id) {
  if (isDirectorViewMode()) {
    showToast('โหมดผู้บริหาร: สำหรับดูข้อมูลอย่างเดียว ไม่สามารถยกเลิกรายการเบิกได้', 'warning');
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'ยืนยันการยกเลิกรายการเบิกเงิน?',
    message: 'ยอดเงินจะถูกคืนกลับเข้ากระปุกกำไรสะสมทันที และสามารถนำไปจัดสรรหรือเบิกใหม่ได้',
    confirmText: 'ยืนยันยกเลิกรายการ',
    cancelText: 'ย้อนกลับ',
    type: 'danger',
    icon: 'fa-trash-can'
  });

  if (!confirmed) return;

  await deleteWithdrawalById(id);
  showToast('ยกเลิกรายการเบิกเงินและคืนยอดเข้ากระปุกกำไรสะสมเรียบร้อย', 'info');
  await loadProfitLedgerData();
}

// Printable Payment Voucher Modal
async function openVoucherModal(withdrawalId) {
  const withdrawals = await fetchWithdrawals();
  const w = withdrawals.find(item => item.id === withdrawalId);
  if (!w) {
    showToast('ไม่พบข้อมูลรายการเบิกเงินนี้', 'error');
    return;
  }

  const closed = await fetchClosedLotsWithDetails();
  const totalEarned = closed.reduce((sum, lot) => sum + ((parseFloat(lot.total_collected) || 0) - (parseFloat(lot.cost) || 5000)), 0);

  // Compute balance before and after this withdrawal chronologically
  const chronological = [...withdrawals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const idx = chronological.findIndex(item => item.id === withdrawalId);
  const withdrawnPrior = chronological.slice(0, idx).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  const balBefore = Math.max(0, totalEarned - withdrawnPrior);
  const balAfter = Math.max(0, balBefore - (parseFloat(w.amount) || 0));

  const amountNum = parseFloat(w.amount) || 0;
  const dateFormatted = new Date(w.date || w.created_at).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  const pvEl = document.getElementById('voucher-pv-no');
  if (pvEl) pvEl.innerText = w.pv_number || `PV-${w.id.slice(0, 8)}`;

  const dateEl = document.getElementById('voucher-date');
  if (dateEl) dateEl.innerText = dateFormatted;

  const catLabel = document.getElementById('voucher-category-label');
  if (catLabel) catLabel.innerText = w.category || 'ทั่วไป';

  const recName = document.getElementById('voucher-recipient-name');
  if (recName) recName.innerText = w.recipient || '-';

  const purpText = document.getElementById('voucher-purpose-text');
  if (purpText) purpText.innerText = w.purpose || '-';

  const tblPurp = document.getElementById('voucher-table-purpose');
  if (tblPurp) tblPurp.innerText = w.purpose || '-';

  const tblCat = document.getElementById('voucher-table-category');
  if (tblCat) tblCat.innerText = w.category || 'ทั่วไป';

  const tblAmt = document.getElementById('voucher-table-amount');
  if (tblAmt) tblAmt.innerText = amountNum.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const bahtEl = document.getElementById('voucher-baht-text');
  if (bahtEl) bahtEl.innerText = `( ${bahtText(amountNum)} )`;

  const totalEl = document.getElementById('voucher-total-amount');
  if (totalEl) totalEl.innerText = `฿${amountNum.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const balBeforeEl = document.getElementById('voucher-bal-before');
  if (balBeforeEl) balBeforeEl.innerText = `฿${balBefore.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

  const balAfterEl = document.getElementById('voucher-bal-after');
  if (balAfterEl) balAfterEl.innerText = `฿${balAfter.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

  const signRec = document.getElementById('voucher-sign-recipient');
  if (signRec) signRec.innerText = w.recipient || '...................................................';

  const signApp = document.getElementById('voucher-sign-approver');
  if (signApp) signApp.innerText = w.approver || 'ผู้อำนวยการโรงเรียน';

  document.getElementById('voucher-modal').classList.remove('hidden');
}

// Toggle printable sections (Statement Box / Signatures)
function toggleReportSection(section, isVisible) {
  if (section === 'statement') {
    const el = document.getElementById('profit-rpt-statement-box');
    if (el) el.classList.toggle('hidden', !isVisible);
  } else if (section === 'signatures') {
    const el = document.getElementById('profit-rpt-signature-section');
    if (el) el.classList.toggle('hidden', !isVisible);
  }
}

// Printable A4 Profit Ledger Report Modal (Type 1: Master Cash Book)
async function openProfitReportModal() {
  const data = await buildMasterCashBookRows();

  // Sync checkboxes and section visibility
  const chkStatement = document.getElementById('toggle-rpt-statement');
  const boxStatement = document.getElementById('profit-rpt-statement-box');
  if (chkStatement && boxStatement) {
    boxStatement.classList.toggle('hidden', !chkStatement.checked);
  }

  const chkSignatures = document.getElementById('toggle-rpt-signatures');
  const boxSignatures = document.getElementById('profit-rpt-signature-section');
  if (chkSignatures && boxSignatures) {
    boxSignatures.classList.toggle('hidden', !chkSignatures.checked);
  }

  const printDateEl = document.getElementById('profit-rpt-print-date');
  if (printDateEl) {
    printDateEl.innerText = new Date().toLocaleDateString('th-TH', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  const rptEarned = document.getElementById('profit-rpt-total-earned');
  if (rptEarned) rptEarned.innerText = `฿${data.totalNetProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const rptWithdrawn = document.getElementById('profit-rpt-total-withdrawn');
  if (rptWithdrawn) rptWithdrawn.innerText = `฿${data.totalWithdrawn.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const rptBal = document.getElementById('profit-rpt-balance');
  if (rptBal) rptBal.innerText = `฿${data.finalBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const rptLots = document.getElementById('profit-rpt-lots-count');
  if (rptLots) rptLots.innerText = `${data.closedLotsCount} งวด`;

  // Render rows in A4 master table
  const tbody = document.getElementById('profit-rpt-master-tbody');
  const tfoot = document.getElementById('profit-rpt-master-tfoot');

  if (tbody) {
    if (data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="border border-slate-400 py-4 text-center text-slate-400">ยังไม่มีรายการในสมุดบัญชีกำไร</td></tr>';
      if (tfoot) tfoot.innerHTML = '';
    } else {
      tbody.innerHTML = data.rows.map(r => {
        if (r.type === 'lot') {
          return `
            <tr class="hover:bg-slate-50/50">
              <td class="border border-slate-400 py-2 px-2 text-center font-mono text-[11px] whitespace-nowrap">${r.dateFormatted}</td>
              <td class="border border-slate-400 py-2 px-3">
                <span class="font-bold text-slate-900">งวดที่ ${r.lotNumber}</span> (ลอต ${r.lotRef})
                <span class="text-[10px] text-slate-500 block">ช่วงขาย: ${r.dateRange}</span>
              </td>
              <td class="border border-slate-400 py-2 px-3 text-right font-mono font-semibold text-blue-700 whitespace-nowrap tabular-nums">฿${r.salesRev.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="border border-slate-400 py-2 px-3 text-right font-mono font-medium text-slate-700 whitespace-nowrap tabular-nums">-฿${r.distCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="border border-slate-400 py-2 px-3 text-right font-mono font-bold text-emerald-800 bg-emerald-50/50 whitespace-nowrap tabular-nums">+฿${r.netProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="border border-slate-400 py-2 px-3 text-center text-slate-300 whitespace-nowrap">-</td>
              <td class="border border-slate-400 py-2 px-3 text-right font-mono font-black text-slate-900 whitespace-nowrap tabular-nums">฿${r.runningBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="border border-slate-400 py-2 px-3 text-xs">
                <div>ตัวแทน Wall's</div>
                ${r.note ? `<span class="text-[10px] text-slate-500 italic block">หมายเหตุ: ${escapeAttr(r.note)}</span>` : ''}
              </td>
            </tr>
          `;
        } else {
          return `
            <tr class="bg-amber-50/30">
              <td class="border border-slate-400 py-2 px-2 text-center font-mono text-[11px] whitespace-nowrap">${r.dateFormatted}</td>
              <td class="border border-slate-400 py-2 px-3">
                <span class="font-bold text-rose-800">[เบิกใช้กำไร]</span> ${escapeAttr(r.purpose)}
                <span class="text-[10px] text-slate-500 block">หมวดหมู่: ${r.category || 'ทั่วไป'}</span>
              </td>
              <td class="border border-slate-400 py-2 px-3 text-center text-slate-300 whitespace-nowrap">-</td>
              <td class="border border-slate-400 py-2 px-3 text-center text-slate-300 whitespace-nowrap">-</td>
              <td class="border border-slate-400 py-2 px-3 text-center text-slate-300 whitespace-nowrap">-</td>
              <td class="border border-slate-400 py-2 px-3 text-right font-mono font-bold text-rose-700 bg-rose-50/50 whitespace-nowrap tabular-nums">-฿${r.withdrawAmt.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="border border-slate-400 py-2 px-3 text-right font-mono font-black text-slate-900 whitespace-nowrap tabular-nums">฿${r.runningBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="border border-slate-400 py-2 px-3 text-xs">
                <div>ผู้รับเงิน: <strong>${escapeAttr(r.recipient)}</strong></div>
              </td>
            </tr>
          `;
        }
      }).join('');

      if (tfoot) {
        tfoot.innerHTML = `
          <tr class="bg-slate-100 font-bold border-t-2 border-slate-400 text-slate-900">
            <td colspan="2" class="border border-slate-400 py-2.5 px-3 text-right font-black whitespace-nowrap">
              รวมทั้งสิ้น
            </td>
            <td class="border border-slate-400 py-2.5 px-3 text-right font-mono font-bold text-blue-800 whitespace-nowrap tabular-nums">
              ฿${data.totalSalesRev.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="border border-slate-400 py-2.5 px-3 text-right font-mono font-bold text-slate-700 whitespace-nowrap tabular-nums">
              -฿${data.totalDistCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="border border-slate-400 py-2.5 px-3 text-right font-mono font-black text-emerald-800 bg-emerald-100/50 whitespace-nowrap tabular-nums">
              +฿${data.totalNetProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="border border-slate-400 py-2.5 px-3 text-right font-mono font-black text-rose-800 bg-rose-100/50 whitespace-nowrap tabular-nums">
              -฿${data.totalWithdrawn.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="border border-slate-400 py-2.5 px-3 text-right font-mono font-black text-slate-900 bg-slate-200/50 whitespace-nowrap tabular-nums">
              ฿${data.finalBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="border border-slate-400 py-2.5 px-3 text-center text-[10px] text-slate-500 font-normal whitespace-nowrap">
              (คงเหลือสุทธิ)
            </td>
          </tr>
        `;
      }
    }
  }

  // Financial Statement Summary Box
  const sumIncome = document.getElementById('profit-rpt-sum-income');
  if (sumIncome) sumIncome.innerText = `+฿${data.totalNetProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const sumExpense = document.getElementById('profit-rpt-sum-expense');
  if (sumExpense) sumExpense.innerText = `-฿${data.totalWithdrawn.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const sumBal = document.getElementById('profit-rpt-sum-balance');
  if (sumBal) sumBal.innerText = `฿${data.finalBalance.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const sumBaht = document.getElementById('profit-rpt-sum-baht-text');
  if (sumBaht) sumBaht.innerText = `( ${bahtText(data.finalBalance)} )`;

  document.getElementById('profit-report-modal').classList.remove('hidden');
}

// Excel / CSV Export for Profit Ledger (Type 1: Master Cash Book)
async function exportProfitLedgerToExcel() {
  const data = await buildMasterCashBookRows();

  let csv = '\uFEFF'; // UTF-8 BOM for Thai font support in Excel

  // Header Title
  csv += `"รายงานสมุดบัญชีกำไร (Wall's POS - ตารางสมุดเงินสดรวมมิตร)"\n`;
  csv += `"วันที่ส่งออกข้อมูล: ${new Date().toLocaleDateString('th-TH')}"\n\n`;

  // Master Cash Book Table
  csv += `"วันที่","รายการ / กิจกรรม","ยอดขายรวม (รับ)","จ่ายต้นทุนบริษัท","กำไรสุทธิงวดนี้","เบิกใช้กำไร (จ่าย)","กำไรสะสมคงเหลือ","ผู้รับเงิน / หน่วยงาน","หมายเหตุ / บันทึกช่วยจำ"\n`;

  data.rows.forEach(r => {
    if (r.type === 'lot') {
      const desc = `งวดที่ ${r.lotNumber} (ลอต ${r.lotRef}) [${r.dateRange}]`;
      const noteClean = (r.note || '').replace(/"/g, '""');
      csv += `"${r.dateFormatted}","${desc}","${r.salesRev}","${r.distCost}","${r.netProfit}","0","${r.runningBalance}","ตัวแทนจำหน่าย Wall's","${noteClean}"\n`;
    } else {
      const desc = `[เบิกใช้กำไร] ${(r.purpose || '').replace(/"/g, '""')}`;
      const recClean = (r.recipient || '').replace(/"/g, '""');
      const catClean = `หมวดหมู่: ${r.category || 'ทั่วไป'}`;
      csv += `"${r.dateFormatted}","${desc}","0","0","0","${r.withdrawAmt}","${r.runningBalance}","${recClean}","${catClean}"\n`;
    }
  });

  // Table Totals
  csv += `"รวมทั้งสิ้น","ทุกรายการ","${data.totalSalesRev}","${data.totalDistCost}","${data.totalNetProfit}","${data.totalWithdrawn}","${data.finalBalance}","",""\n\n`;

  // Summary Statement
  csv += `"สรุปงบบัญชีเงินกำไร (Statement of Profit & Expense)"\n`;
  csv += `"รายรับรวม (กำไรสุทธิสะสมทั้งหมด)","${data.totalNetProfit}"\n`;
  csv += `"รายจ่ายรวม (เบิกใช้กำไรไปแล้ว)","${data.totalWithdrawn}"\n`;
  csv += `"ยอดเงินกำไรคงเหลือสุทธิในกองทุน","${data.finalBalance}"\n`;
  csv += `"ตัวอักษร","${bahtText(data.finalBalance)}"\n`;

  // Trigger download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateFormatted = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `รายงานสมุดบัญชีกำไร_walls_${dateFormatted}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`ส่งออกไฟล์ Excel "${a.download}" สำเร็จแล้ว!`, 'success');
}
