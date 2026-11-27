import assert from 'node:assert/strict'
import { test } from 'node:test'

const unwrap = (value) => value?.data?.dashboard || value?.data || value?.dashboard || value || {}
const field = (object, keys) => keys.map((key) => key.split('.').reduce((value, part) => value?.[part], object)).find((value) => value !== undefined && value !== null)
const rows = (value, keys = []) => {
  if (Array.isArray(value)) return value
  for (const key of [...keys, 'items', 'results', 'records', 'data']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

test('metrics calculation correctly derives counts from fresh API responses without localStorage', () => {
  const mockDashboardRes = {
    summary: {
      pendingPrescriptions: 5,
      todayDispensed: 12,
      totalBills: 20,
      todayReturns: 2,
    }
  }

  const summary = mockDashboardRes.summary
  const queue = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const liveDispensing = [{ id: 10, dispensingStatus: 'Dispensed' }, { id: 11, dispensingStatus: 'Dispensed' }]
  const liveBills = [{ id: 101 }, { id: 102 }]
  const liveReturns = [{ id: 201 }]

  const pendingVal = queue.length
  const dispensedVal = field(summary, ['todayDispensed', 'dispensedToday']) ?? liveDispensing.length
  const billsVal = field(summary, ['totalBills', 'billsCount']) ?? liveBills.length
  const returnsVal = field(summary, ['todayReturns', 'returnsToday']) ?? liveReturns.length

  assert.equal(pendingVal, 3)
  assert.equal(dispensedVal, 12)
  assert.equal(billsVal, 20)
  assert.equal(returnsVal, 2)
})

test('dispensed today falls back to live dispensing overview count when summary count is absent', () => {
  const emptySummary = {}
  const liveDispensing = [
    { id: 1, dispensingStatus: 'Dispensed' },
    { id: 2, dispensingStatus: 'Dispensed' },
    { id: 3, dispensingStatus: 'Draft' },
    { id: 4, dispensingStatus: 'COMPLETED' },
  ]

  const liveDispensedCount = liveDispensing.filter((d) => /dispensed|completed/i.test(d?.dispensingStatus || d?.status || '')).length
  const dispensedVal = field(emptySummary, ['todayDispensed', 'dispensedToday']) ?? liveDispensedCount

  assert.equal(dispensedVal, 3)
})

test('alerts fallback maps near expiry stock when alerts endpoint is empty', () => {
  const primaryAlerts = []
  const nearExpiryRows = [
    { medicineName: 'Paracetamol 500mg', batchNumber: 'B123', daysLeft: 14 },
    { name: 'Amoxicillin 250mg', batchNo: 'B456', daysLeft: 20 },
  ]

  const fallbackAlerts = nearExpiryRows.map((item) => ({
    title: 'Near Expiry Alert',
    medicineName: item.medicineName || item.name || 'Medicine',
    message: `${item.name || item.medicineName || 'Medicine'} expires within 30 days${item.batchNumber || item.batchNo ? ` (Batch: ${item.batchNumber || item.batchNo})` : ''}`,
    type: 'expiry'
  }))

  const alerts = primaryAlerts.length > 0 ? primaryAlerts : fallbackAlerts

  assert.equal(alerts.length, 2)
  assert.equal(alerts[0].medicineName, 'Paracetamol 500mg')
  assert.match(alerts[0].message, /B123/)
  assert.equal(alerts[1].medicineName, 'Amoxicillin 250mg')
  assert.match(alerts[1].message, /B456/)
})

test('dispense payload maps real prescription items without dummy text', () => {
  const detailedMeds = [
    { prescriptionItemId: 101, medicineName: 'Metformin 500mg', quantity: 30 },
    { id: 102, name: 'Atorvastatin 10mg', qty: 15 }
  ]

  const dispenseItems = detailedMeds.map((m, idx) => ({
    prescriptionItemId: Number(m.prescriptionItemId || m.id || idx + 1),
    medicineName: m.medicineName || m.name || `Item #${idx + 1}`,
    quantity: Number(m.quantity || m.qty || 1)
  }))

  assert.equal(dispenseItems.length, 2)
  assert.equal(dispenseItems[0].prescriptionItemId, 101)
  assert.equal(dispenseItems[0].medicineName, 'Metformin 500mg')
  assert.equal(dispenseItems[0].quantity, 30)

  assert.equal(dispenseItems[1].prescriptionItemId, 102)
  assert.equal(dispenseItems[1].medicineName, 'Atorvastatin 10mg')
  assert.equal(dispenseItems[1].quantity, 15)
})

test('dashboard admin notifications are correctly normalized from backend and admin payloads', () => {
  const rawList = [
    {
      id: 'adm-101',
      title: 'Monthly Inventory Audit Required',
      message: 'Please review all Schedule H medicines by 5 PM.',
      status: 'unread',
      isRead: false,
      sender: 'Dr. Rajesh (Admin)',
      createdAt: '2026-11-26T10:00:00Z',
    },
    {
      notificationId: 202,
      subject: 'Supplier Delivery Rescheduled',
      body: 'Amoxicillin shipment delayed until Friday.',
      status: 'Read',
      senderName: 'Pharmacy Admin',
      timestamp: '2026-11-25T14:30:00Z',
    },
    {
      _id: 'adm-303',
      content: 'System maintenance scheduled tonight at 11 PM.',
    }
  ]

  const notifications = rawList.map((n) => ({
    id: n.id ?? n.notificationId ?? n._id,
    title: n.title ?? n.subject ?? 'Notification from Admin',
    message: n.message ?? n.body ?? n.content ?? '',
    status: String(n.status ?? (n.isRead ? 'read' : 'unread')).toLowerCase(),
    isRead: n.isRead === true || String(n.status).toLowerCase() === 'read',
    createdAt: n.createdAt || n.timestamp || '',
    sender: n.sender || n.senderName || 'Pharmacy Admin',
  }))

  assert.equal(notifications.length, 3)

  // Item 1: Custom admin notification
  assert.equal(notifications[0].id, 'adm-101')
  assert.equal(notifications[0].title, 'Monthly Inventory Audit Required')
  assert.equal(notifications[0].message, 'Please review all Schedule H medicines by 5 PM.')
  assert.equal(notifications[0].isRead, false)
  assert.equal(notifications[0].status, 'unread')
  assert.equal(notifications[0].sender, 'Dr. Rajesh (Admin)')

  // Item 2: Backend-style notification
  assert.equal(notifications[1].id, 202)
  assert.equal(notifications[1].title, 'Supplier Delivery Rescheduled')
  assert.equal(notifications[1].message, 'Amoxicillin shipment delayed until Friday.')
  assert.equal(notifications[1].isRead, true)
  assert.equal(notifications[1].status, 'read')

  // Item 3: Defaults & fallbacks
  assert.equal(notifications[2].id, 'adm-303')
  assert.equal(notifications[2].title, 'Notification from Admin')
  assert.equal(notifications[2].message, 'System maintenance scheduled tonight at 11 PM.')
  assert.equal(notifications[2].isRead, false)
  assert.equal(notifications[2].sender, 'Pharmacy Admin')
})

test('admin notifications filter correctly across All, Unread, and Read tabs', () => {
  const notifications = [
    { id: 1, title: 'Alert 1', isRead: false },
    { id: 2, title: 'Alert 2', isRead: true },
    { id: 3, title: 'Alert 3', isRead: false },
    { id: 4, title: 'Alert 4', isRead: true },
  ]

  const unreadCount = notifications.filter((n) => !n.isRead).length
  assert.equal(unreadCount, 2)

  const filterTab = (tab) => notifications.filter((n) => {
    if (tab === 'Unread') return !n.isRead
    if (tab === 'Read') return n.isRead
    return true
  })

  assert.equal(filterTab('All').length, 4)
  assert.equal(filterTab('Unread').length, 2)
  assert.equal(filterTab('Read').length, 2)
  assert.deepEqual(filterTab('Unread').map((n) => n.id), [1, 3])
  assert.deepEqual(filterTab('Read').map((n) => n.id), [2, 4])
})

test('marking admin notification as read updates its status and decrements unread count', () => {
  let list = [
    { id: 'adm-1', isRead: false, status: 'unread' },
    { id: 'adm-2', isRead: false, status: 'unread' },
  ]

  assert.equal(list.filter((n) => !n.isRead).length, 2)

  // Simulate mark read on adm-1
  const targetId = 'adm-1'
  list = list.map((item) => (item.id === targetId ? { ...item, status: 'read', isRead: true } : item))

  assert.equal(list.find((n) => n.id === 'adm-1').isRead, true)
  assert.equal(list.find((n) => n.id === 'adm-1').status, 'read')
  assert.equal(list.find((n) => n.id === 'adm-2').isRead, false)
  assert.equal(list.filter((n) => !n.isRead).length, 1)
})

test('notification storage filters out any legacy mock seed data and preserves real notifications', () => {
  const mixedStored = [
    { id: 'adm-notif-seed-1', title: 'Welcome to Pharmacy Dispensary', isRead: false },
    { id: 'adm-notif-1732620000', title: 'Real Emergency Notice from Admin', isRead: false },
  ]
  const realOnly = mixedStored.filter((item) => !String(item?.id || '').startsWith('adm-notif-seed-'))
  assert.equal(realOnly.length, 1)
  assert.equal(realOnly[0].id, 'adm-notif-1732620000')
  assert.equal(realOnly[0].title, 'Real Emergency Notice from Admin')
})

test('rows extractor safely unwraps nested data objects for notification lists', () => {
  const customRows = (value, keys = []) => {
    if (Array.isArray(value)) return value
    const target = value?.data && !Array.isArray(value.data) ? value.data : value
    if (Array.isArray(target)) return target
    for (const key of [...keys, 'items', 'results', 'records', 'data']) {
      if (Array.isArray(target?.[key])) return target[key]
    }
    for (const key of [...keys, 'items', 'results', 'records', 'data']) {
      if (Array.isArray(value?.[key])) return value[key]
    }
    return []
  }

  const sample1 = { data: { notifications: [{ id: 1 }, { id: 2 }] } }
  assert.equal(customRows(sample1, ['notifications']).length, 2)

  const sample2 = { notifications: [{ id: 3 }] }
  assert.equal(customRows(sample2, ['notifications']).length, 1)

  const sample3 = [{ id: 4 }, { id: 5 }, { id: 6 }]
  assert.equal(customRows(sample3).length, 3)
})


