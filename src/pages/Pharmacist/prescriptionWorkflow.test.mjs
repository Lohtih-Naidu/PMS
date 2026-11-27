import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newPrescription, prescriptionPayload, prescriptionTotals, savedRecord, updateMedicine, validatePrescription, parsePrescriptionDispensePlan, dispensingDraftPayload } from './prescriptionModel.js'

function validDraft() {
  const draft = newPrescription()
  draft.patient.patientName = 'Example Patient'
  draft.patient.doctorName = 'Example Doctor'
  draft.patient.patientPhone = '9876543210'
  draft.medicines[0] = { ...draft.medicines[0], medicineName: 'Medicine A', strength: 'As prescribed', morning: '1', afternoon: '0', evening: '1', days: '5', quantity: '10', unitPrice: '10' }
  return draft
}

test('dose schedule changes calculate quantity without losing editable medicine details', () => {
  const draft = validDraft()
  assert.equal(updateMedicine(draft.medicines[0], 'days', '7').quantity, '14')
  assert.equal(updateMedicine(draft.medicines[0], 'morning', '.5').quantity, '8')
  assert.equal(updateMedicine(draft.medicines[0], 'quantity', '20').quantity, '20')
})

test('totals use line amounts rounded to currency precision', () => {
  assert.deepEqual(prescriptionTotals([{ quantity: '3', unitPrice: '.10' }, { quantity: '2', unitPrice: '.20' }]), { quantity: 5, amount: .70, lines: [.30, .40] })
})

test('manual prescription payload preserves patient details and all three dose times', () => {
  const draft = validDraft()
  const payload = prescriptionPayload(draft)
  assert.equal(payload.patientName, 'Example Patient')
  assert.equal(payload.medicines[0].dosage, '1-0-1')
  assert.equal(payload.medicines[0].morning, true)
  assert.equal(payload.medicines[0].afternoon, false)
  assert.equal(payload.medicines[0].evening, true)
  assert.equal(payload.medicines[0].days, 5)
  assert.equal(payload.medicines[0].quantity, 10)
  assert.equal(payload.photo, undefined)
  assert.equal(payload.prescriptionDate.length, 10)
})

test('API schedule flags are booleans while fractional and multiple doses remain in dosage', () => {
  const draft = validDraft()
  draft.medicines[0] = { ...draft.medicines[0], morning: '.5', afternoon: '', evening: '2' }
  const medicine = JSON.parse(JSON.stringify(prescriptionPayload(draft))).medicines[0]
  assert.equal(medicine.morning, true)
  assert.equal(medicine.afternoon, false)
  assert.equal(medicine.evening, true)
  assert.equal(medicine.dosage, '0.5-0-2')
  assert.equal(draft.medicines[0].morning, '.5')
})

test('patient, schedule, quantity, duration and price errors prevent checkout', () => {
  const draft = validDraft()
  assert.doesNotThrow(() => validatePrescription(draft))
  for (const [key, value] of [['morning', '-1'], ['days', '0'], ['quantity', '1.5'], ['unitPrice', '-2'], ['medicineName', '']]) {
    assert.throws(() => validatePrescription({ ...draft, medicines: [{ ...draft.medicines[0], [key]: value }] }))
  }
  assert.throws(() => validatePrescription({ ...draft, patient: { ...draft.patient, patientPhone: '123' } }))
})

test('only real server prescription and bill references advance checkout', () => {
  assert.equal(savedRecord({ data: { prescription: { id: 'rx-1' } } }, 'prescription').id, 'rx-1')
  assert.equal(savedRecord({ data: { billId: 42, totalAmount: 150 } }, 'bill').id, '42')
  assert.throws(() => savedRecord({ success: true }, 'prescription'), /did not return/)
})

test('parsePrescriptionDispensePlan maps actual backend prescriptionItemId and quantities', () => {
  const backendDetails = {
    prescriptionId: 101,
    status: 'Pending',
    medicines: [
      { prescriptionItemId: 501, medicineName: 'Amoxicillin 500mg', quantity: 15, dispensedQuantity: 0 },
      { prescriptionItemId: 502, medicineName: 'Paracetamol 650mg', quantity: 10, remainingQuantity: 10 }
    ]
  }
  const plan = parsePrescriptionDispensePlan(backendDetails)
  assert.equal(plan.isAlreadyDispensed, false)
  assert.equal(plan.itemsToDispense.length, 2)
  assert.deepEqual(plan.itemsToDispense, [
    { prescriptionItemId: 501, quantity: 15 },
    { prescriptionItemId: 502, quantity: 10 }
  ])
})

test('parsePrescriptionDispensePlan skips dispensing when prescription is already fully dispensed', () => {
  const fullyDispensedDetails = {
    prescriptionId: 102,
    status: 'Dispensed',
    medicines: [
      { prescriptionItemId: 503, medicineName: 'Azithromycin 500mg', quantity: 3, dispensedQuantity: 3 }
    ]
  }
  const plan = parsePrescriptionDispensePlan(fullyDispensedDetails)
  assert.equal(plan.isAlreadyDispensed, true)
  assert.equal(plan.itemsToDispense.length, 0)
})

test('parsePrescriptionDispensePlan handles partial dispensing and ignores already dispensed items', () => {
  const partialDetails = {
    prescriptionId: 103,
    status: 'PartiallyDispensed',
    medicines: [
      { prescriptionItemId: 601, quantity: 20, dispensedQuantity: 5 }, // 15 remaining
      { prescriptionItemId: 602, quantity: 10, dispensedQuantity: 10, status: 'Dispensed' } // 0 remaining, completed
    ]
  }
  const plan = parsePrescriptionDispensePlan(partialDetails)
  assert.equal(plan.isAlreadyDispensed, false)
  assert.equal(plan.itemsToDispense.length, 1)
  assert.deepEqual(plan.itemsToDispense, [
    { prescriptionItemId: 601, quantity: 15 }
  ])
})

test('dispensing to billing execution workflow halts on dispensing failure and skips billing', async () => {
  const calls = []
  const mockApi = {
    getDetails: async (rxId) => {
      calls.push(`GET details ${rxId}`)
      return {
        status: 'Pending',
        medicines: [{ prescriptionItemId: 701, quantity: 5 }]
      }
    },
    dispense: async (payload) => {
      calls.push(`POST dispense rx=${payload.prescriptionId}`)
      throw new Error('Insufficient stock for medicine item 701')
    },
    generateBill: async (payload) => {
      calls.push(`POST generate-bill rx=${payload.prescriptionId}`)
      return { id: 'bill-1', totalAmount: 100 }
    }
  }

  let errorThrown = null
  try {
    const rxId = 1
    const details = await mockApi.getDetails(rxId)
    const plan = parsePrescriptionDispensePlan(details)
    if (!plan.isAlreadyDispensed && plan.itemsToDispense.length > 0) {
      await mockApi.dispense({ prescriptionId: rxId, medicines: plan.itemsToDispense })
    }
    await mockApi.generateBill({ prescriptionId: rxId, discount: 0 })
  } catch (err) {
    errorThrown = err
  }

  assert.equal(errorThrown?.message, 'Insufficient stock for medicine item 701')
  assert.equal(calls.includes('POST generate-bill rx=1'), false)
  assert.deepEqual(calls, ['GET details 1', 'POST dispense rx=1'])
})

test('dispensing to billing execution workflow confirms dispensing before generating bill', async () => {
  const calls = []
  let rxStatus = 'Pending'

  const mockApi = {
    getDetails: async (rxId) => {
      calls.push(`GET details ${rxId}`)
      return {
        status: rxStatus,
        medicines: [{ prescriptionItemId: 801, quantity: 10 }]
      }
    },
    dispense: async (payload) => {
      calls.push(`POST dispense rx=${payload.prescriptionId} items=${payload.medicines.length}`)
      rxStatus = 'Dispensed'
      return { success: true, prescription: { status: 'Dispensed' } }
    },
    generateBill: async (payload) => {
      calls.push(`POST generate-bill rx=${payload.prescriptionId}`)
      return { id: 'bill-99', totalAmount: 250 }
    }
  }

  const rxId = 42
  const details = await mockApi.getDetails(rxId)
  const plan = parsePrescriptionDispensePlan(details)
  if (!plan.isAlreadyDispensed && plan.itemsToDispense.length > 0) {
    const res = await mockApi.dispense({ prescriptionId: rxId, medicines: plan.itemsToDispense })
    assert.equal(res.success, true)
  }
  const bill = await mockApi.generateBill({ prescriptionId: rxId, discount: 0 })

  assert.equal(bill.id, 'bill-99')
  assert.deepEqual(calls, [
    'GET details 42',
    'POST dispense rx=42 items=1',
    'POST generate-bill rx=42'
  ])
})

test('dispensing quantity validation supports 0-0-0 doses with manual quantity (e.g. 10 at 43.12)', () => {
  const draft = validDraft()
  draft.medicines[0] = {
    ...draft.medicines[0],
    medicineId: 101,
    medicineName: 'Special Medicine',
    strength: '500mg',
    morning: '0',
    afternoon: '0',
    evening: '0',
    days: '1',
    quantity: '10',
    unitPrice: '43.12'
  }

  // 1. Totals calculation
  const totals = prescriptionTotals(draft.medicines)
  assert.equal(totals.quantity, 10)
  assert.equal(totals.amount, 431.20)
  assert.deepEqual(totals.lines, [431.20])

  // 2. Draft validation does not throw
  assert.doesNotThrow(() => validatePrescription(draft))

  // 3. Draft payload creation produces exact effective quantity 10
  const payload = dispensingDraftPayload(draft, {
    availableMeds: [{ medicineId: 101, name: 'Special Medicine', strength: '500mg' }]
  })
  assert.equal(payload.medicines[0].medicineId, 101)
  assert.equal(payload.medicines[0].morning, 0)
  assert.equal(payload.medicines[0].afternoon, 0)
  assert.equal(payload.medicines[0].evening, 0)
  assert.equal(payload.medicines[0].durationDays, 1)
  assert.equal(payload.medicines[0].quantity, 10)
})

test('updating schedule preserves manual quantity when doses are zero, and auto-calculates when positive', () => {
  const row = {
    medicineName: 'Special Medicine',
    strength: '500mg',
    morning: '0',
    afternoon: '0',
    evening: '0',
    days: '1',
    quantity: '10',
    unitPrice: '43.12'
  }

  // Changing days when perDay is 0 preserves manual quantity
  const updatedDays = updateMedicine(row, 'days', '2')
  assert.equal(updatedDays.quantity, '10')

  // Changing morning to 1 triggers auto-calculation (1 per day * 2 days = 2)
  const updatedMorning = updateMedicine(updatedDays, 'morning', '1')
  assert.equal(updatedMorning.quantity, '2')

  // Manual adjustment overwrites auto-calculation
  const manualQty = updateMedicine(updatedMorning, 'quantity', '25')
  assert.equal(manualQty.quantity, '25')
})

test('quantity validation rejects invalid, zero, negative, fractional, and out-of-range quantities', () => {
  const draft = validDraft()
  const invalidQuantities = ['0', '-1', '1.5', '100001', '', 'abc']

  for (const qty of invalidQuantities) {
    const invalidDraft = {
      ...draft,
      medicines: [{ ...draft.medicines[0], medicineId: 101, morning: '0', afternoon: '0', evening: '0', days: '1', quantity: qty }]
    }
    assert.throws(
      () => validatePrescription(invalidDraft),
      /Enter valid days and quantity/
    )
    assert.throws(
      () => dispensingDraftPayload(invalidDraft, {
        availableMeds: [{ medicineId: 101, name: 'Medicine A', strength: 'As prescribed' }]
      })
    )
  }
})


