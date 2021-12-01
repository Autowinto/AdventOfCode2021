/**
 * This is a module written with three main purposes in mind:
 * 1. Cleaning up the routing logic for the IT Confidence Backend API to make it easier to understand and work with.
 *
 * 2. Handling all logic involving getting data from Atera and e-conomic in one place to avoid spaghetti. Data manipulation does not happen here.
 * This is solely for the endpoint logic to call.
 *
 * 3. Avoid a lot of redundancy in writing API endpoints and therefore speeding up general development of the backend.
 */

import { User } from './../models/mgmt/users.interfaces'
import axios from 'axios'
import * as mariadb from 'mariadb'
import { ateraConfig, economicConfig } from '../config'
import { cTrim, parseQueryString } from '../utils/formatUtils'
import dayjs, { QUnitType } from 'dayjs'
import duration from 'dayjs/plugin/duration'
import quarterOfYear from 'dayjs/plugin/quarterOfYear'
import timezone from 'dayjs/plugin/timezone'
dayjs.extend(duration)
dayjs.extend(quarterOfYear)
dayjs.extend(timezone)

import rateLimiter from 'axios-rate-limit'
import { Knex, knex } from 'knex'
import { sendEmail } from '../utils/emailUtils'
import * as db from '../models/database'
import * as streamOne from '../models/streamone'
import { getUsersByTenantId } from '../models/mgmt'
export const axiosLmtd = rateLimiter(axios.create(ateraConfig), {
  maxRequests: 6,
  perMilliseconds: 1000,
  maxRPS: 6,
})
import { parsePhoneAsE164 } from '../utils/phoneUtils'
import Password from '../models/database/password'
// import Alias from '../models/database/alias'

export const knexClient: Knex = knex({
  client: 'mysql',
  connection: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PWD,
    database: process.env.DB_NAME,
    typeCast: function (field: any, next: any) {
      if (field.type == 'TINY' && field.length == 1) {
        return field.string() == '1' // 1 = true, 0 = false
      }
      return next()
    },
    dateStrings: true,
  },
})

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PWD,
  database: process.env.DB_NAME,
  connectionLimit: 150,
  dateStrings: true,
}

console.log('Setting up database with the following config', dbConfig)
export const pool = mariadb.createPool(dbConfig)

export function getAteraId(id: number) {
  return new Promise(function (resolve, reject) {
    pool
      .query(
        `
        SELECT ateraId 
        FROM customers 
        WHERE customerId=${id}`,
      )
      .then((response) => {
        resolve(response[0].ateraId)
      })
      .catch((error) => {
        console.log(error)
      })
  })
}

async function getMicrosoftIdByEmail(email: string) {
  const microsoftId = await pool.query(`
    SELECT microsoftId
    FROM employees
    WHERE email = '${email}'
  `)
  if (microsoftId[0]) {
    return microsoftId[0].microsoftId
  } else {
    return null
  }
}

export async function getSecurityLevels() {
  return await knexClient('roles').select('roleId', 'name')
}

export async function getWorkHourRecordsByEmployee(
  id: string,
  page: number,
  results: number,
  sortColumn: string,
  sortDirection: string,
) {
  if (!page) page = 1
  if (!results) results = 10000
  const workHourRecords = await pool.query(`
    SELECT
    id,
    customers.ateraId,
    workhourrecords.ticketId,
    workhourrecords.employee,
    IF (billable = 1,'true', 'false') as billable,
    rate,
    description,
    startTime,
    endTime,
    time,
    timeRounded,
    customers.customerId,
    customers.name AS customerName,
    IF (isInvoiced = 1,'true', 'false') as isInvoiced
    FROM workhourrecords
       LEFT JOIN tickets ON workhourrecords.ticketId=tickets.ticketId
       INNER JOIN customers ON tickets.customer=customers.customerId 
    WHERE workhourrecords.employee = '${id}'
    AND deleted != 1
    ORDER BY ${sortColumn} ${sortDirection}
    LIMIT ${results}
    OFFSET ${results * page - results}
  `)
  const count = await pool.query(`
  SELECT COUNT(*) AS totalItems
  FROM workhourrecords
  WHERE employee = '${id}'
  AND deleted != 1
`)

  return {
    collection: workHourRecords,
    pagination: count[0],
  }
}

export async function getTotalWorkHoursByEmployee(id: string, startDate: string, endDate: string) {
  const total = await pool.query(`
    SELECT     
    SEC_TO_TIME( SUM( TIME_TO_SEC (time))) as time,
    SEC_TO_TIME( SUM( TIME_TO_SEC (timeRounded))) as rounded
    
    FROM workhourrecords
    WHERE endTime between '${startDate}' and '${endDate}'
    AND employee='${id}'
    AND deleted != 1
  `)
  let billable = await pool.query(`
    SELECT 
    SEC_TO_TIME( SUM( TIME_TO_SEC (time))) as time,
    SEC_TO_TIME( SUM( TIME_TO_SEC (timeRounded))) as rounded
    
    FROM workhourrecords
    WHERE endTime between '${startDate}' and '${endDate}'
    AND employee='${id}'
    AND billable
    AND deleted != 1
`)

  return {
    total: {
      seconds: total[0].time,
      rounded: total[0].rounded,
    },
    billable: {
      seconds: billable[0].time,
      rounded: billable[0].rounded,
    },
  }
}
export async function getRoleByEmployee(microsoftId: string) {
  const request = await knexClient('roles')
    .select('roles.name', 'employees.role')
    .leftJoin('employees', 'roles.roleId', '=', 'employees.role')
    .where('microsoftId', microsoftId)
    .first()

  return request
}

function formatSecondsAsTime(timeInSeconds: number) {
  const hours = Math.floor(timeInSeconds / 3600) // Divide time by 3600 to get hours
  const minutes = Math.floor((timeInSeconds % 3600) / 60) // Find the remainder that isn't a whole hour and multiply by 60 to get minutes
  const seconds = timeInSeconds % 60 //
  return `${hours}:${minutes}:${seconds}`
}

export async function getCustomers(
  page = 1,
  results = 10000,
  sortColumn = 'customerId',
  sortDirection = 'ASC',
  searchColumn: string = 'customerId',
  searchValue: string = '',
): Promise<{
  collection: any
  pagination: any
}> {
  try {
    const response = await knexClient('customers')
      .leftJoin('aliases', 'customers.customerId', '=', 'aliases.customer')
      .select('*')
      .whereNot('customerId', 0)
      .where('customerId', 'like', `%${searchValue}%`)
      .orWhere('name', 'like', `%${searchValue}%`)
      .orWhere('aliases.alias', 'like', `%${searchValue}%`)
      .orderBy(sortColumn, sortDirection)
      .groupBy('name')
      .limit(results)
      .offset(results * page - results)
      .catch((err) => {
        console.error(err)
      })

    const count = await knexClient('customers')
      .leftJoin('aliases', 'customers.customerId', '=', 'aliases.customer')
      .whereNot('customerId', 0)
      .where('customerId', 'like', `%${searchValue}%`)
      .orWhere('name', 'like', `%${searchValue}%`)
      .orWhere('aliases.alias', 'like', `%${searchValue}%`)
      .count('', { as: 'totalItems' })
    return {
      collection: response,
      pagination: count[0],
    }
  } catch (error) {
    console.error(error)
    throw error
  }
}

export async function createCustomer(body: any) {
  let economicBody: any = {
    name: body.name,
    customerNumber: parseInt(body.cvr),
    corporateIdentificationNumber: body.cvr,
    paymentTerms: {
      paymentTermsNumber: body.paymentTerms,
    },
    customerGroup: {
      customerGroupNumber: body.group,
    },
    currency: body.currency,
    vatZone: {
      vatZoneNumber: body.vatZone,
    },
    address: body.address,
    city: body.city,
    country: body.country,
    zip: body.zip,
    telephoneAndFaxNumber: parsePhoneAsE164(body.telephoneAndFaxNumber),
  }

  let ateraBody: any = {
    CustomerName: body.name,
    BusinessNumber: body.cvr,
    Domain: body.domain,
    Address: body.address,
    City: body.city,
    Country: body.country,
    Phone: parsePhoneAsE164(body.phone),
  }

  economicBody = Object.entries(economicBody).reduce(
    (a: any, [k, v]) => (v ? ((a[k] = v), a) : a),
    {},
  )
  ateraBody = Object.entries(ateraBody).reduce((a: any, [k, v]) => (v ? ((a[k] = v), a) : a), {})

  // Try to create the customer in the economic registry
  try {
    await axios.post(`https://restapi.e-conomic.com/customers`, economicBody, economicConfig)
  } catch (error: any) {
    console.error(error.response.data.errors.customerNumber.errors)
    throw 'Failed to initialize customer in e-conomic,'
  }

  let ateraResponse
  try {
    ateraResponse = await axiosLmtd.post(
      `https://app.atera.com/api/v3/customers`,
      ateraBody,
      ateraConfig,
    )
  } catch (error) {
    console.error(error)
    throw 'Failed to initialize customer in Atera. Deleting in e-conomic'
    //Delete customer in e-conomic here
  }

  try {
    await pool.query(`
      INSERT INTO customers
        (customerId, economicId, ateraId, name, phone, employee, invoiceFrequency)
      VALUES (
        '${cTrim(body.cvr)}', 
        '${body.cvr}',
        '${ateraResponse.data.ActionID}',
        '${body.name}',
        '${parsePhoneAsE164(body.phone)}',
        '${body.employee}',
        ${body.invoiceFrequency})`)
  } catch (error) {
    console.error(error)
    throw 'Failed to initialize customer in database. Deleting in e-conomic and Atera'
  }
  return
}

export async function updateCustomer(customerId: number, body: any) {
  const ateraId = await getAteraId(customerId)
  console.log(body)
  let economicBody: any = {
    name: body.name,
    customerNumber: Number(body.customerId),
    corporateIdentificationNumber: String(body.customerId),
    paymentTerms: {
      paymentTermsNumber: body.paymentTermsNumber,
    },
    ean: body.ean,
    customerGroup: {
      customerGroupNumber: body.customerGroupNumber,
    },
    email: body.invoicingEmail,
    currency: body.currency,
    vatZone: {
      vatZoneNumber: body.vatZoneNumber,
    },
    address: body.address,
    city: body.city,
    country: body.country,
    zip: body.zip,
    telephoneAndFaxNumber: parsePhoneAsE164(body.phone),
    eInvoicingDisabledByDefault: body.eInvoicingDisabledByDefault,
  }

  let ateraBody: any = {
    CustomerName: body.name,
    BusinessNumber: body.customerId,
    Domain: body.domain,
    Address: body.address,
    City: body.city,
    Country: body.country,
    Phone: parsePhoneAsE164(body.phone),
  }

  economicBody = Object.entries(economicBody).reduce(
    (a: any, [k, v]) => (v ? ((a[k] = v), a) : a),
    {},
  )
  ateraBody = Object.entries(ateraBody).reduce((a: any, [k, v]) => (v ? ((a[k] = v), a) : a), {})

  try {
    await axios.put(
      `https://restapi.e-conomic.com/customers/${customerId}`,
      economicBody,
      economicConfig,
    )
  } catch (error: any) {
    console.error('Failed updating economic')
    console.error(error.response.data)
    throw error
  }

  try {
    await axiosLmtd.put(`https://app.atera.com/api/v3/customers/${ateraId}`, ateraBody, ateraConfig)
  } catch (error) {
    console.log('Failed updating atera')
    throw error
  }
  try {
    let response = await pool.query(`
      UPDATE customers
      SET name='${parseQueryString(body.name)}', phone='${parsePhoneAsE164(
      body.phone,
    )}', employee='${body.employee}', invoiceFrequency=${
      body.invoiceFrequency
    }, invoiceSingleTickets=${body.invoiceSingleTickets}, accessToOperationsCenter=${
      body.accessToOperationsCenter
    },
      email='${body.email}',
      accountStatementEmail='${body.accountStatementEmail}',
      reminderEmail='${body.reminderEmail}',
      microsoftId='${body.microsoftId ? body.microsoftId : ''}'
      WHERE customerId='${customerId}'
    `)
    // logger.log(`Edited customer with ID: ${customerId}`)
    return response
  } catch (error) {
    throw error
  }
}

// A recent cleanup may have slowed down this function a bit. Perhaps improve performance by
// splitting api calls into their own routes

export async function getCustomerById(id: number) {
  try {
    const queryRes = await pool.query(
      `SELECT ateraId, economicId, customers.microsoftId, employee, employees.name AS employeeName, invoiceFrequency, 
        frequencies.name AS invoiceFrequencyName, IF(invoiceSingleTickets, 'true', 'false') invoiceSingleTickets, IF(accessToOperationsCenter, 'true', 'false') accessToOperationsCenter ,
        customers.email, reminderEmail, accountStatementEmail
        FROM customers
          LEFT JOIN employees ON customers.employee = employees.microsoftId
          LEFT JOIN frequencies ON customers.invoiceFrequency = frequencies.id
        WHERE customerId=${id}`,
    )

    const qRes = queryRes[0]

    const [economicResponse, ateraResponse] = await Promise.all([
      axios.get(`https://restapi.e-conomic.com/customers/${qRes.economicId}`, economicConfig),
      axiosLmtd.get(`https://app.atera.com/api/v3/customers/${qRes.ateraId}`, ateraConfig),
    ])

    const eco = economicResponse.data
    const ate = ateraResponse.data

    const [paymentTermResponse, customerGroupResponse] = await Promise.all([
      axios.get(`${economicResponse.data.paymentTerms.self}`, economicConfig),
      await axios.get(`${economicResponse.data.customerGroup.self}`, economicConfig),
    ])

    const data = {
      address: eco.address,
      balance: eco.balance,
      city: eco.city,
      customerNumber: id,
      microsoftId: qRes.microsoftId,
      country: eco.country,
      currency: eco.currency,
      customerGroupNumber: customerGroupResponse.data.customerGroupNumber,
      customerGroupName: customerGroupResponse.data.name,
      domain: ate.Domain,
      ean: eco.ean,
      publicEntryNumber: eco.publicEntryNumber,
      invoicingEmail: eco.email,
      email: qRes.email,
      reminderEmail: qRes.reminderEmail,
      accountStatementEmail: qRes.accountStatementEmail,
      eInvoicingDisabledByDefault: eco.eInvoicingDisabledByDefault,
      name: eco.name,
      paymentTermsNumber: paymentTermResponse.data.paymentTermsNumber,
      paymentTermsName: paymentTermResponse.data.name,
      phone: parsePhoneAsE164(eco.telephoneAndFaxNumber),
      vatZoneName: eco.vatZone.name,
      vatZoneNumber: eco.vatZone.vatZoneNumber,
      vatZone: eco.vatZone,
      zip: eco.zip,
      longitude: ate.longitude,
      latitude: ate.latitude,
      apiInfo: qRes.ateraId,
      employee: qRes.employee,
      employeeName: qRes.employeeName,
      invoiceFrequency: qRes.invoiceFrequency,
      invoiceFrequencyName: qRes.invoiceFrequencyName,
      invoiceSingleTickets: qRes.invoiceSingleTickets,
      accessToOperationsCenter: qRes.accessToOperationsCenter,
    }
    return data
  } catch (err) {
    throw err
  }
}

export async function getTicketsByCustomer(
  customerId: number,
  page: number,
  results: number,
  sortColumn: string,
  sortDirection: string,
  searchValue: string = '',
) {
  try {
    const response = await knexClient('tickets')
      .select('*')
      .orderBy(sortColumn, sortDirection)
      .limit(results)
      .offset(results * page - results)
      .where({ customer: customerId })
      .andWhere((ctx) => {
        ctx.where('ticketId', 'like', `%${searchValue}%`)
        ctx.orWhere('subject', 'like', `%${searchValue}%`)
      })

    // const response = await pool.query(
    //   `SELECT * FROM tickets
    //   WHERE customer='${customerId}'
    //   ORDER BY ${sortColumn} ${sortDirection}
    //   LIMIT ${results}
    //   OFFSET ${results * page - results}
    //   `,
    // )

    const count = await pool.query(`
      SELECT COUNT(*) AS totalItems
      FROM tickets
      WHERE customer='${customerId}'
      `)

    return {
      collection: response,
      pagination: count[0],
    }
  } catch (error) {
    throw error
  }
}

export async function getPdf(url: string) {
  let pdf = await axios.get(url, {
    baseURL: economicConfig.baseURL,
    headers: economicConfig.headers,
    responseType: 'arraybuffer',
  })
  return pdf.data
}

export async function getInvoicesByCustomer(
  id: number,
  page: number,
  results: number,
  type: string,
  sortColumn: string,
  sortDirection: string,
) {
  if (sortDirection == 'DESC') {
    sortColumn = `-${sortColumn}`
  }

  try {
    let invoices = await axios.get(
      `https://restapi.e-conomic.com/invoices/${type}?skippages=${
        page - 1
      }&pagesize=${results}&filter=customer.customerNumber$eq:${id}&sort=${sortColumn}`,
      economicConfig,
    )

    return {
      collection: invoices.data.collection,
      pagination: {
        totalItems: invoices.data.pagination.results,
      },
    }
  } catch (error) {
    throw new Error('Failed to fetch invoices by customer')
  }
}

export async function getCustomerGroups() {
  try {
    const response = await axios.get(
      `https://restapi.e-conomic.com/customer-groups`,
      economicConfig,
    )
    return response.data.collection
  } catch (err) {
    console.error(err)
  }
}

export async function getCurrencies() {
  try {
    const response = await axios.get(`https://restapi.e-conomic.com/currencies`, economicConfig)
    return response.data.collection
  } catch (err) {
    console.error(err)
  }
}
export async function getVatZones() {
  try {
    const response = await axios.get(`https://restapi.e-conomic.com/vat-zones`, economicConfig)
    return response.data.collection
  } catch (err) {
    console.error(err)
  }
}
export async function getPaymentTerms() {
  try {
    const response = await axios.get(`https://restapi.e-conomic.com/payment-terms`, economicConfig)
    return response.data.collection
  } catch (err) {
    console.error(err)
  }
}

export async function getProducts() {
  try {
    const response = await getEconomicData('products')
    return response
  } catch (error) {
    throw new Error('Failed to fetch products')
  }
}

export async function getProductById(productId: number) {
  try {
    let response = await axios.get(
      `https://restapi.e-conomic.com/products/${productId}`,
      economicConfig,
    )
    return response
  } catch (error) {
    throw error
  }
}

export async function getTickets(
  page: number,
  results: number,
  sortColumn: string,
  sortDirection: string,
  searchValue: string = '',
) {
  if (!page) page = 1
  if (!results) results = 1000

  try {
    const tickets = await knexClient('tickets')
      .select(
        'ticketId',
        'customer AS customerId',
        'customers.name AS customerName',
        'contact',
        'subject',
        'createdDate',
        'modifiedDate',
        'status',
        'replyStatus',
      )
      // This needs to be changed to be a choice rather than hard-coded, but is a quick solution for now
      .where((ctx) => {
        ctx.where({ status: 'Open' }).orWhere({ status: 'Pending' })
      })
      .andWhere((ctx) => {
        ctx
          .where('subject', 'like', `%${searchValue}%`)
          .orWhere('ticketId', 'like', `%${searchValue}%`)
      })
      .leftJoin('customers', 'customers.customerId', 'tickets.customer')
      .orderBy(sortColumn, sortDirection)
      .limit(results)
      .offset(results * page - results)

    const count = await knexClient('tickets')
      .count('* as totalItems')
      .where((ctx) => {
        ctx.where({ status: 'Open' }).orWhere({ status: 'Pending' })
      })
      .andWhere((ctx) => {
        ctx
          .where('subject', 'like', `%${searchValue}%`)
          .orWhere('ticketId', 'like', `%${searchValue}%`)
      })

    return {
      collection: tickets,
      pagination: count[0],
    }
  } catch (error) {
    throw error
  }
}

export async function getTicketById(id: number) {
  let ticket = await axiosLmtd.get(`https://app.atera.com/api/v3/tickets/${id}`, ateraConfig)

  console.log(ticket.data)

  let query = await pool.query(`
  SELECT IF(isProject, 'true', 'false') isProject, fixedPrice
  FROM tickets WHERE ticketId = ${id}`)
  ticket.data.isProject = query[0].isProject
  ticket.data.fixedPrice = query[0].fixedPrice
  console.log(ticket.data)

  return ticket.data
}

export async function createTicket(body: any) {
  try {
    const contact = await knexClient('contacts')
      .select('ateraId')
      .where({ contactId: body.contactId })
      .first()

    const ticketBody = {
      EndUserID: contact.ateraId,
      TicketTitle: body.title,
      Description: body.description,
      TicketType: body.type,
      TicketStatus: body.ticketStatus,
      TicketImpact: body.impact,
      TechnicianContactID: body.technicianId,
    }
    let ateraResponse = await axiosLmtd.post(
      `https://app.atera.com/api/v3/tickets`,
      ticketBody,
      ateraConfig,
    )
    await axios.put(
      `https://app.atera.com/api/v3/tickets/${ateraResponse.data.ActionID}`,
      ticketBody,
      ateraConfig,
    )

    if (!body.createdDate) body.createdDate = dayjs().format('YYYY-MM-DD HH:mm:ss')
    if (!body.modifiedDate) body.modifiedDate = dayjs().format('YYYY-MM-DD HH:mm:ss')
    try {
      await pool.query(
        `
      INSERT INTO tickets
      (ticketId, customer, contact, subject, createdDate, modifiedDate, status, replyStatus, isProject, fixedPrice, estimatedHours)
      VALUES
      ('${ateraResponse.data.ActionID}','${body.customerId}', '${
          body.contactId
        }', '${parseQueryString(body.description)}', '${body.createdDate}', '${
          body.modifiedDate
        }', 'Pending', 'Technician Replied', ${body.isProject}, ${body.fixedPrice || null}, ${
          body.estimatedHours ? `'${body.estimatedHours}'` : null
        })`,
      )

      return ateraResponse.data
    } catch (error) {
      console.error(error)
      axiosLmtd
        .delete(`https://app.atera.com/api/v3/tickets/${ateraResponse.data.ActionID}`)
        .then(() => {
          throw {
            status: 500,
            message: 'Failed to create ticket in SQL database',
          }
        })
    }
  } catch (error) {
    console.error(error)
    throw { status: 500, message: 'Failed to create ticket in Atera system' }
  }
}

export async function getCallsByCustomer(customerId: number) {
  try {
    let calls = await pool.query(`
    SELECT * FROM phoneentries
    WHERE customer = ${customerId}
    ORDER BY deliveredTime DESC
    `)
    return calls
  } catch (error) {
    throw { status: 500, message: 'Failed to fetch calls in SQL database' }
  }
}

export async function getContactsByCustomer(id: number) {
  const contacts = await knexClient('contacts')
    .select(
      'contactId',
      'economicId',
      'customer',
      'firstName',
      'lastName',
      'jobTitle',
      'email',
      'o365Id',
    )
    .where({ customer: id })
    .orderBy('firstName', 'asc')
    .orderBy('lastName', 'asc')

  for (const contact of contacts) {
    let phones = await pool.query(`
      SELECT *
      FROM contactphonenumbers
      WHERE contact=${contact.contactId}
      `)
    contact.phones = phones
  }
  return contacts
}

interface ContactBody {
  businessNumber: number
  name: string
  firstName: string
  lastName: string
  title?: string
  phone?: string
  email: string
  notify?: boolean
  o365Id?: string
}

export function createContact(body: ContactBody) {
  getAteraId(body.businessNumber).then((ateraId) => {
    var ateraBody: any = {
      CustomerID: ateraId,
      CustomerName: body.name,
      Firstname: body.firstName,
      Lastname: body.lastName,
      JobTitle: body.title,
      Phone: parsePhoneAsE164(body.phone),
      Email: body.email,
    }

    ateraBody = Object.entries(ateraBody).reduce((a: any, [k, v]) => (v ? ((a[k] = v), a) : a), {})

    axiosLmtd
      .post(`https://app.atera.com/api/v3/contacts/`, ateraBody, ateraConfig)
      .then((ateraResponse) => {
        let economicBody = {
          email: body.email,
          phone: parsePhoneAsE164(body.phone),
          name: `${body.firstName} ${body.lastName}`,
          emailNotifications: body.notify,
          notes: `${ateraResponse.data.ActionID}`,
        }

        economicBody = Object.entries(economicBody).reduce(
          (a: any, [k, v]) => (v ? ((a[k] = v), a) : a),
          {},
        )

        axios
          .post(
            `https://restapi.e-conomic.com/customers/${body.businessNumber}/contacts`,
            economicBody,
            economicConfig,
          )
          .then((response) => {
            if (!body.o365Id) body.o365Id = 'NULL'
            pool
              .query(
                `
                  INSERT INTO contacts
                  (ateraId, economicId, customer, firstName, lastName, jobTitle, email)
                  VALUES
                  (
                    ${ateraResponse.data.ActionID}, 
                    ${response.data.customerContactNumber}, 
                    ${body.businessNumber}, '${body.firstName}', 
                    '${body.lastName}', '${body.title}','${body.email}'
                  )
                `,
              )
              .catch((error) => {
                console.error(error)
              })
          })
          .catch((error) => {
            console.error(error)
          })
      })
      .catch((error) => {
        console.error(error.response.data.InnerException)
      })
  })
}

export async function createPassword(body: any) {
  const password = Password.create(body as Password)
  password.customer = body.customerId
  await password.save().catch((error) => {
    console.error(error)
    throw { status: 500, message: 'Failed to created password on backend' }
  })
}

export async function updatePassword(body: any) {
  await Password.save(body).catch((error) => {
    console.error(error)
    throw { status: 500, message: 'Failed to update password on backend' }
  })
}

export function getCustomerRatesById(id: number) {
  return new Promise(function (resolve, reject) {
    pool.getConnection().then((conn) => {
      conn
        .query(
          `SELECT drivingRate, supportRate, consultantRate FROM ${process.env.DB_NAME}.customers WHERE customerId=${id}`,
        )
        .then((response) => {
          resolve(response[0])
        })
        .catch((error) => {
          reject(error)
        })
      conn.release()
    })
  })
}

export function editCustomerRatesById(id: number, body: any) {
  return new Promise(function (resolve, reject) {
    pool.getConnection().then((conn) => {
      if (body.drivingRate) {
        conn
          .query(
            `UPDATE ${process.env.DB_NAME}.customers 
          SET drivingRate = ${body.drivingRate}, 
          supportRate = ${body.supportRate}, 
          consultantRate = ${body.consultantRate} 
          WHERE customerId=${id}`,
          )
          .then((response) => {
            resolve(response[0])
          })
          .catch((error) => {
            reject(error)
          })
      }
    })
  })
}

export async function getSubscriptionGroups() {
  let response = await pool.query(`
    SELECT id, name
    FROM subscriptiongroups

  `)

  let count = await pool.query(`
  SELECT COUNT(*) AS totalItems
  FROM subscriptiongroups
`)

  return {
    collection: response,
    pagination: count[0],
  }
}

export async function createSubscriptionGroup(body: any) {
  try {
    pool.query(`
      INSERT INTO subscriptiongroups
      (name)
      VALUES ('${body.name}')
    `)
  } catch (error) {
    console.log(error)
  }
}

export async function updateSubscriptionGroup(id: number, body: any) {
  return pool.query(`
    UPDATE subscriptiongroups
    SET name = '${body.name}'
    WHERE id = ${id}
  `)
}

export async function deleteSubscriptionGroup(id: number) {
  await pool.query(`
    DELETE FROM subscriptiongroups
    WHERE id = ${id}`)
}

export async function getSubscriptions(
  page: number,
  results: number,
  sortColumn: string,
  sortDirection: string,
) {
  let data = await pool.query(`
    SELECT subscriptions.id, product, subscriptions.name, description, 
    active, price, DATE_FORMAT(startDate, '%X-%c-%d') AS startDate, 
    DATE_FORMAT(endDate, '%X-%c-%d') AS endDate,  
    subscriptiongroups.id AS groupId, subscriptiongroups.name AS groupName,
    billingengines.id AS billingEngineId,
    billingengines.name AS billingEngineName,
    paymentFrequency.id AS paymentFrequencyId,
    paymentFrequency.name AS paymentFrequencyName,
    ticketFrequency.id AS ticketFrequencyId,
    ticketFrequency.name AS ticketFrequencyName
    FROM subscriptions
      LEFT JOIN subscriptiongroups
        ON subscriptions.subscriptionGroup = subscriptiongroups.id
      LEFT JOIN billingengines
        ON subscriptions.billingEngine = billingengines.id
      INNER JOIN frequencies AS paymentFrequency
        ON subscriptions.paymentFrequency = paymentFrequency.id
      INNER JOIN frequencies AS ticketFrequency
        ON subscriptions.ticketFrequency = ticketFrequency.id
    ORDER BY ${sortColumn} ${sortDirection}
      LIMIT ${results}
      OFFSET ${results * page - results}
  `)

  let count = await pool.query(`
  SELECT COUNT(*) AS totalItems
  FROM subscriptions
`)

  return {
    collection: data,
    pagination: count[0],
  }
}

export async function getSubscriptionById(id: number) {
  const sub = await knexClient('subscriptions').select('*').where({ id: id }).first()
  return sub
}

interface SubscriptionBody {
  product: number
  name: string
  sku?: string
  description: string
  billingEngine: number
  price: number
  group: number
  startDate: string
  endDate?: string
  ticketFrequencyId: number
  paymentFrequencyId: number
}

export async function createSubscription(body: SubscriptionBody) {
  let response = await pool.query(`
    INSERT INTO subscriptions (
      product,
      name, 
      description, 
      billingEngine, 
      price, 
      subscriptionGroup, 
      startDate, 
      ticketFrequency, 
      paymentFrequency)

    VALUES
    (${body.product}, '${parseQueryString(body.name)}', '${parseQueryString(body.description)}', ${
    body.billingEngine
  }, 
    ${body.price}, ${body.group}, '${body.startDate}',
    ${body.ticketFrequencyId}, ${body.paymentFrequencyId})
  `)

  if (body.endDate != undefined) {
    await pool.query(`
      UPDATE subscriptions 
      SET endDate = '${body.endDate}'
      WHERE id = ${response.insertId}
      `)
  }
  if (body.sku != undefined) {
    console.log(body.sku, response.insertId)
    await knexClient('subscriptions').update({ sku: body.sku }).where({ id: response.insertId })
  }
}

export async function updateSubscription(id: number, body: any) {
  await pool.query(`
    UPDATE subscriptions
    SET product = ${body.product}, name = '${body.name}', 
      billingEngine = ${body.billingEngineId}, description = '${body.description}', 
      active = ${body.active}, price = ${body.price}, 
      startDate = '${body.startDate}', 
      ticketFrequency = ${body.ticketFrequencyId},
      paymentFrequency = ${body.paymentFrequencyId}
    WHERE id = ${id}
  `)
  if (body.endDate !== null) {
    await pool.query(`
      UPDATE subscriptions
      SET endDate = '${body.endDate}'
    `)
  }
}

export async function deleteSubscription(id: number) {
  return pool.query(`
    UPDATE subscriptions
    SET active = 0
    WHERE id = ${id}
  `)
}

export async function getBillingEngines() {
  try {
    return await knexClient('billingengines').select('id', 'name')
  } catch (err) {
    console.error(err)
    throw new Error('Failed to fetch billing engines')
  }
}

export async function getSubscriptionFrequencies() {
  try {
    let data = await pool.query(`
      SELECT *
      FROM frequencies`)
    return data
  } catch (err) {
    console.error(err)
    throw new Error('Failed to fetch billing engines')
  }
}

export async function getSubscriptionInstancesByCustomer(
  id: number,
  page: number,
  results: number,
  sortColumn: string,
  sortDirection: string,
  searchValue: string = '',
) {
  let data = await pool.query(`
    SELECT ins.id, ins.name, posts.units, posts.unitPrice, posts.startDate,
      posts.endDate, subscriptions.id as subscriptionId,
      subscriptions.name as subscriptionName, 
      subscriptions.billingEngine as billingEngineId, 
      billingengines.name as billingEngineName,
      ins.description
    FROM subscriptioninstances as ins
      LEFT JOIN subscriptions
        ON ins.subscription = subscriptions.id
      LEFT JOIN billingengines
        ON subscriptions.billingEngine = billingengines.id
      LEFT JOIN subscriptioninstanceposts AS posts
        ON ins.id = posts.instance
        AND posts.id = (SELECT MAX(posts.id)
          FROM subscriptioninstanceposts AS posts
          WHERE ins.id = posts.instance)
    WHERE customer = ${id}
    AND (ins.name like '%${searchValue}%')
    ORDER BY ${sortColumn} ${sortDirection}, subscriptions.subscriptionGroup ASC
    LIMIT ${results}
    OFFSET ${results * page - results}
  `)

  let count = await pool.query(`
    SELECT COUNT(*) AS totalItems
    FROM subscriptioninstances
    WHERE customer = ${id}
`)

  return {
    collection: data,
    pagination: count[0],
  }
}

export async function createSubscriptionInstance(
  id: number,
  body: {
    name: string
    subscriptionId: number
    units: number
    unitPrice: number
    startDate: string
    endDate?: string
  },
) {
  try {
    let instanceResponse = await pool.query(`
      INSERT INTO subscriptioninstances
        (name, subscription, customer)
      VALUES
        ('${body.name}', ${body.subscriptionId}, ${id})
    `)

    let postResponse = await pool.query(`
      INSERT INTO subscriptioninstanceposts
        (units, unitPrice, startDate, instance)
      VALUES
        (
          '${body.units}', 
          '${body.unitPrice}', 
          '${body.startDate}',
          '${instanceResponse.insertId}'
        )
    `)

    if (body.endDate && body.endDate.length) {
      await pool.query(`
        UPDATE subscriptioninstanceposts 
        SET endDate = '${body.endDate}'
        WHERE id = ${postResponse.insertId}
        `)
    }
  } catch (error) {
    console.error(error)
    throw {
      status: 500,
      message: 'An error occured while creating a subscription instance',
    }
  }
}

export async function updateSubscriptionInstance(id: number, body: any) {
  try {
    let instanceResponse = await pool.query(`
    UPDATE subscriptioninstances
    SET name = '${body.name}', subscription = ${body.subscriptionId}, description = '${body.description}'
    WHERE id = ${id}
  `)

    let prevResponse = await pool.query(`
      SELECT * 
      FROM subscriptioninstanceposts
      WHERE id = (
        SELECT MAX(id) as postId
        FROM subscriptioninstanceposts
        WHERE instance = ${id}
      )
    
    `)

    //Check if units are different
    if (prevResponse[0].units != body.units || prevResponse[0].unitPrice != body.unitPrice) {
      //End the current post by setting the end date to today
      await pool.query(`
      UPDATE subscriptioninstanceposts
      SET endDate = '${dayjs().subtract(1, 'day').format('YYYY-MM-DD')}'
      WHERE id = (
        SELECT MAX(id) as postId
        FROM subscriptioninstanceposts
        WHERE instance = ${id}
      )
    `)

      // Create a new post and set the starting date to today
      let postResponse = await pool.query(`
      INSERT INTO subscriptioninstanceposts
        (units, unitPrice, startDate, instance)
      VALUES
        (
          '${body.units}',
          '${body.unitPrice}', 
          '${dayjs().format('YYYY-MM-DD')}',
          '${id}'
        )
    `)

      if (body.endDate != undefined) {
        await pool.query(`
      UPDATE subscriptioninstanceposts 
      SET endDate = '${body.endDate}'
      WHERE id = ${postResponse.insertId}
      `)
      }

      return postResponse
    }
    if (prevResponse[0].startDate != body.startDate) {
      await pool.query(`
        UPDATE subscriptioninstanceposts
        SET startDate = '${body.startDate}'
        WHERE id = (
          SELECT MIN(id) as postId
          FROM subscriptioninstanceposts
          WHERE instance = ${id}
        )
      `)
    }
    if (prevResponse[0].endDate != body.endDate) {
      pool.query(`
        UPDATE subscriptioninstanceposts
        SET endDate = '${body.endDate}'
        WHERE id = (
          SELECT MAX(id) as postId
          FROM subscriptioninstanceposts
          WHERE instance = ${id}
        )
      `)
    }
    return instanceResponse
  } catch (error) {
    console.log(error)
  }
}

export async function deleteSubscriptionInstance(id: number) {
  try {
    await pool.query(`
    DELETE FROM subscriptioninstances
    WHERE id = ${id}
    `)
  } catch (error) {
    console.error(error)
  }

  try {
    await pool.query(`
    DELETE FROM subscriptioninstanceposts
    WHERE instance = ${id}
    `)
  } catch (error) {
    console.error(error)
  }
}

export function getDaysIn(unit: string) {
  if (unit == 'halfYear') {
    const quarter = dayjs().quarter()
    if (quarter <= 2) {
      return Math.floor(
        dayjs.duration(dayjs().quarter(2).endOf('quarter').diff(dayjs().startOf('year'))).asDays(),
      )
    } else if (quarter >= 3) {
      return Math.floor(
        dayjs.duration(dayjs().endOf('year').diff(dayjs().quarter(3).startOf('quarter'))).asDays(),
      )
    }
  }

  // Always add 1 since the diff function doesn't include end days
  return (
    dayjs()
      .endOf(unit as QUnitType)
      .diff(dayjs().startOf(unit as QUnitType), 'days') + 1
  )
}

//FIXME: This function is a jumbled mess. It needs to be rewritten and refactored.
export async function getInvoiceData(customerId: number) {
  //Create a date object, subtract 1 month and set the day to 23 to be the 23rd of last month

  let subscriptionGroups = (await getSubscriptionGroups()).collection

  let subscriptions = await pool.query(`
    SELECT id, product, name, subscriptionGroup, paymentFrequency FROM subscriptions
  `)

  let subscriptioninstances = await pool.query(`
    SELECT subscriptioninstances.id, subscriptioninstances.name, subscription, lastInvoiced, subscriptioninstances.description, subscriptions.paymentFrequency FROM subscriptioninstances
    LEFT JOIN subscriptions
    ON subscriptioninstances.subscription = subscriptions.id
    WHERE customer = ${customerId}
  `)

  for (let instance of subscriptioninstances) {
    let startOfPeriod
    let endOfPeriod
    let minimumSinceLastInvoice
    switch (instance.paymentFrequency) {
      case 4:
        startOfPeriod = dayjs().startOf('month')
        endOfPeriod = dayjs().endOf('month')
        minimumSinceLastInvoice = 28
        break
      case 6:
        startOfPeriod = dayjs().startOf('quarter')
        endOfPeriod = dayjs().endOf('quarter')
        minimumSinceLastInvoice = 88
        break
      case 7:
        const quarter = dayjs().quarter()
        if (quarter <= 2) {
          startOfPeriod = dayjs().startOf('year')
          endOfPeriod = dayjs().quarter(2).endOf('quarter')
        } else if (quarter >= 3) startOfPeriod = dayjs().quarter(3).startOf('quarter')
        endOfPeriod = dayjs().endOf('year')
        minimumSinceLastInvoice = 120
        break
      case 8:
        // startOfPeriod = dayjs().startOf('year')
        // endOfPeriod = dayjs().endOf('year')
        startOfPeriod = dayjs()
        endOfPeriod = dayjs().add(1, 'year')
        minimumSinceLastInvoice = 340
        break
    }

    if (startOfPeriod && endOfPeriod) {
      let subscriptioninstanceposts = await pool.query(`
        SELECT * FROM subscriptioninstanceposts
        WHERE instance = ${instance.id}
        AND (endDate BETWEEN '${startOfPeriod?.format('YYYY-MM-DD')}' 
        AND '${endOfPeriod?.format('YYYY-MM-DD')}'
        OR endDate >= '${dayjs().format('YYYY-MM-DD')}'
        OR endDate IS NULL)
        AND startDate <= '${endOfPeriod?.format('YYYY-MM-DD')}'
        AND ${dayjs
          .duration(dayjs().diff(dayjs(instance.lastInvoiced)))
          .asDays()} >= ${minimumSinceLastInvoice}
        AND units > 0
      `)
      instance.posts = subscriptioninstanceposts
    }
  }

  let filteredInstances = subscriptioninstances.filter((obj: any) => obj.posts.length !== 0)

  for (let sub of subscriptions) {
    let instances = filteredInstances.filter((obj: any) => obj.subscription == sub.id)
    sub.instances = instances
  }

  let filteredSubscriptions = subscriptions.filter((obj: any) => obj.instances.length !== 0)

  for (let group of subscriptionGroups) {
    let subs = filteredSubscriptions.filter((obj: any) => obj.subscriptionGroup == group.id)
    group.subscriptions = subs
  }

  let filteredSubGroups = subscriptionGroups.filter((obj: any) => obj.subscriptions.length !== 0)
  return filteredSubGroups
}

export async function createInvoice(invoiceBody: any) {
  try {
    const response = await axios.post(
      `https://restapi.e-conomic.com/invoices/drafts`,
      invoiceBody,
      economicConfig,
    )
    return response
  } catch (error: any) {
    console.error(error.response.data.errors)
    throw new Error('Failed to create invoice')
  }
}

export async function getConsultantHoursInvoiceData(customerId: number) {
  let tickets = await pool.query(`
    SELECT tickets.ticketId, tickets.subject, tickets.customer, contacts.firstName, contacts.lastName FROM tickets
    JOIN contacts ON tickets.contact = contacts.contactId
    WHERE tickets.customer = ${customerId}
    AND isProject = 0
  `)

  console.log(tickets)

  for (const [, ticket] of tickets.entries()) {
    const workhourrecords = await pool.query(
      `
  SELECT id, ateraId, ticketId as ticket, employee, description, rate, startTime, endTime, time, timeRounded
  FROM workhourrecords
  WHERE ticketId = ${ticket.ticketId}
  AND deleted = 0
  AND isInvoiced = 0
  AND billable = 1
  AND timeRounded != '00:00:00'
  AND endTime <= NOW()`,
    )

    ticket.workhourrecords = workhourrecords
  }
  const filtered = tickets.filter((obj: any) => obj.workhourrecords.length > 0)
  return filtered
}

export async function getProjectInvoiceData(customerId: number) {
  let tickets: any[] = await pool.query(`
  SELECT tickets.ticketId, tickets.subject, tickets.customer, contacts.firstName, tickets.fixedPrice, contacts.lastName FROM tickets
  LEFT JOIN contacts ON tickets.contact = contacts.contactId
  WHERE tickets.customer = ${customerId}
  AND isProject = 1
  AND status IN ('Closed', 'Resolved')
  `)
  // console.log(tickets)
  let ticketList = []
  for (const ticket of tickets) {
    const workhourrecords: any[] = await pool.query(`
    SELECT id, ateraId, ticketId as ticket, employee, description, rate, startTime, endTime, time, timeRounded, isInvoiced
    FROM workhourrecords
    WHERE ticketId = ${ticket.ticketId}
    AND deleted = 0
    AND billable = 1
    AND timeRounded != '00:00:00'
    `)
    if (ticket.fixedPrice != null) {
      for (let i = 0; i < workhourrecords.length; i++) {
        workhourrecords[i].rate = 0
      }
    }
    //   console.log(ticket.ticketId, ticket.workhourrecords)
    ticket.workhourrecords = workhourrecords
    const isInvoiced = ticket.workhourrecords.some((obj: any) => obj.isInvoiced == 1)
    if (!isInvoiced) ticketList.push(ticket)
    //   // // If any of the workhourrecords are already invoiced, assume the project has already been invoiced and remove the ticket
    //   // console.log(ticket)
  }
  const filteredWithRecords = ticketList.filter((obj: any) => obj.workhourrecords.length > 0)
  const filtered = filteredWithRecords.filter((obj: any) =>
    obj.workhourrecords.some((record: any) => record.isInvoiced == 0),
  )

  return filtered
}

// Code for the original
export async function getConsultantHoursInvoiceDataMonthly(customerId: number) {
  let tickets = await pool.query(`
    SELECT * FROM tickets
    WHERE customer = ${customerId}
    AND isProject = 0
  `)

  for (const [, ticket] of tickets.entries()) {
    const workhourrecords = await pool.query(`
    SELECT id, ateraId, ticketId as ticket, employee, description, rate, startTime, endTime, time, timeRounded
    FROM workhourrecords
    WHERE ticketId = ${ticket.ticketId}
    AND deleted = 0
    AND isInvoiced = 0
    AND billable = 1
    AND timeRounded != '00:00:00'
    AND endTime <= DATE_SUB(NOW(), INTERVAL 1 DAY)
    `)

    ticket.workhourrecords = workhourrecords
  }
  const filtered = tickets.filter((obj: any) => obj.workhourrecords.length > 0)
  console.log(JSON.stringify(tickets))
  return filtered
}

export async function updateCustomers() {
  const economicData = await getEconomicData('customers')
  // let businessNumbers = Object.values(economicData)

  for (const customer of economicData) {
    try {
      pool.query(
        `INSERT INTO customers (customerId, economicId, name) 
        VALUES ('${cTrim(customer.customerNumber)}', '${
          customer.customerNumber
        }', '${parseQueryString(customer.name)}')
        ON DUPLICATE KEY UPDATE customerId='${cTrim(customer.customerNumber)}', economicId='${
          customer.customerNumber
        }', name='${parseQueryString(customer.name)}'`,
      )
    } catch (error) {
      console.error(error)
    }
  }

  const ateraData = await getAteraData('customers', 'multiple')
  for (const item in ateraData) {
    try {
      pool.query(
        `UPDATE ${process.env.DB_NAME}.customers SET ateraId=${
          ateraData[item].CustomerID
        }, phone=${parsePhoneAsE164(ateraData[item].Phone)} 
        WHERE customerId=${cTrim(ateraData[item].BusinessNumber)}`,
      )
    } catch (error) {
      console.error('Error in updating customers with atera number', error)
    }
  }
}

export async function importContacts() {
  const contacts = await getAteraData('contacts', 'multiple')

  for (const contact of contacts) {
    console.log(contact)
    try {
      const customerData = await pool.query(`
        SELECT customerId
        FROM customers
        WHERE ateraId=${contact.CustomerID}`) //Get the internal IT-Confidence customer id for use in the next query.
      const r = customerData[0]

      //Only insert if we know the customer the contact person is associated with
      if (customerData[0]) {
        const dbContact = await knexClient('contacts')
          .select()
          .where({ ateraId: contact.EndUserID })
          .first()
        if (!dbContact) {
          await pool.query(`
            INSERT INTO contacts 
              (ateraId, customer, firstName, lastName, jobTitle, email)
            VALUES
              ('${contact.EndUserID}', '${r.customerId}',
              '${parseQueryString(contact.Firstname)}', '${parseQueryString(contact.Lastname)}', 
              '${contact.JobTitle}', '${contact.Email}')
          `)
        }
      }
    } catch (error) {
      console.log(error)
    }
  }
}

export async function generateMissingEconomicContacts() {
  console.log('Generating missing economic contacts')
  const contacts = await knexClient('contacts').select('*').whereNull('economicId')
  for (const contact of contacts) {
    try {
      let data = await (
        await axiosLmtd.get(`https://app.atera.com/api/v3/contacts/${contact.ateraId}`, ateraConfig)
      ).data
      if (data) {
        try {
          console.log({
            name: `${contact.firstName} ${contact.lastName}`,
            email: contact.email,
            notes: contact.contactId,
          })
          const ecoRes = await axios.post(
            `https://restapi.e-conomic.com/customers/${contact.customer}/contacts`,
            {
              name: `${contact.firstName} ${contact.lastName}`,
              email: contact.email,
            },
            economicConfig,
          )
          await knexClient('contacts')
            .where({ contactId: contact.contactId })
            .update({ economicId: ecoRes.data.customerContactNumber })
        } catch (err) {
          console.error(err)
        }
      }
    } catch (err) {
      console.error(err)
    }
  }
}

//TODO: This needs to be cleaned up heavily.
export async function updateTickets() {
  console.log('Updating tickets')
  let tickets = await getAteraData('tickets', 'multiple')

  let customers = await pool.query(`
    SELECT customerId, ateraId
    FROM customers
  `)

  tickets.forEach(async (ticket: any) => {
    let userCommentTimestamp = dayjs(ticket.LastEndUserCommentTimestamp).isValid()
      ? dayjs(ticket.LastEndUserCommentTimestamp)
      : '1000-01-01T08:00:00Z'
    let technicianCommentTimestamp = dayjs(ticket.LastTechnicianCommentTimestamp).isValid()
      ? dayjs(ticket.LastTechnicianCommentTimestamp)
      : '1000-01-01T08:00:00Z'
    let ticketResolvedTimestamp = dayjs(ticket.TicketResolvedDate).isValid()
      ? dayjs(ticket.TicketResolvedDate)
      : '1000-01-01T08:00:00Z'

    let customer = customers.find((ateraId: any) => ateraId.ateraId === ticket.CustomerID)

    if (customer) {
      console.log(customer.customerId)
      let customerId = customer.customerId
      let replyStatus = dayjs(ticket.LastEndUserCommentTimestamp).isSameOrAfter(
        ticket.LastTechnicianCommentTimestamp,
      )
        ? 'Customer Replied'
        : 'Technician Replied'

      const contact = await knexClient('contacts')
        .select()
        .where({ ateraId: ticket.EndUserID })
        .first()

      if (contact) {
        console.log(contact.contactId, ticket.TicketID)
        await pool.query(`
          INSERT INTO tickets (
            ticketId, customer, contact, subject, createdDate, modifiedDate, isProject, 
            status, replyStatus
          )
          VALUES (
            '${ticket.TicketID}', '${customerId}', '${contact.contactId}',
            '${parseQueryString(ticket.TicketTitle)}', 
            '${dayjs(ticket.TicketCreatedDate).format('YYYY-MM-DD HH:mm:ss')}',
            '${dayjs
              .max(
                dayjs(userCommentTimestamp),
                dayjs(technicianCommentTimestamp),
                dayjs(ticketResolvedTimestamp),
              )
              .format('YYYY-MM-DD HH:mm:ss')}',
              0,
            '${ticket.TicketStatus}',
            '${replyStatus}')
  
            ON DUPLICATE KEY UPDATE
              ticketId='${ticket.TicketID}',
              customer='${customerId}',
              contact='${contact.contactId}',
              subject='${parseQueryString(ticket.TicketTitle)}',
              createdDate='${dayjs(ticket.TicketCreatedDate).format('YYYY-MM-DD HH:mm:ss')}',
              modifiedDate='${dayjs
                .max(
                  dayjs(userCommentTimestamp),
                  dayjs(technicianCommentTimestamp),
                  dayjs(ticketResolvedTimestamp),
                )
                .format('YYYY-MM-DD HH:mm:ss')}',
              status='${ticket.TicketStatus}',
              replyStatus='${replyStatus}'
        `)
      }
    }
  })
  console.log('Finished')
}

export async function updateWorkHourRecord(id: number, body: any) {
  return await pool.query(`
    UPDATE workhourrecords
    SET 
      billable = ${body.billable},
      rate= ${body.rate},
      description = '${parseQueryString(body.description)}',
      time = '${body.time}',
      timeRounded = '${body.timeRounded}',
      edited = 1
    WHERE id = ${id}
  `)
}

export async function deleteWorkHourRecord(id: number) {
  //Due to the fact that it isn't possible to delete a work hour record
  //through Atera's API, we mark the record as being deleted and ignore it
  return await pool.query(`
    UPDATE workhourrecords
    SET deleted = 1
    WHERE id = ${id}
  `)
}

//TODO: Speed this up by removing unnecessary awaits
export async function updateWorkHourRecords() {
  console.log('Updating workhours')
  let tickets = await pool.query(`
    SELECT ticketId
    FROM tickets
  `)

  let i = 1
  for (let ticket of tickets) {
    console.log(i)
    i++
    let ticketId = ticket.ticketId
    let workHourRecords = await getAteraData(`tickets/${ticketId}/workhoursrecords`, 'multiple')

    for (let record of workHourRecords) {
      const startTime: dayjs.Dayjs = dayjs(record.StartWorkHour).tz('Europe/Copenhagen')
      const endTime: dayjs.Dayjs = dayjs(record.EndWorkHour).tz('Europe/Copenhagen')
      const seconds = endTime.diff(startTime, 'second')

      const microsoftId = await getMicrosoftIdByEmail(record.TechnicianEmail)
      if (microsoftId == null) break

      const matchingRecords = await pool.query(`
        SELECT * FROM workhourrecords
        WHERE ateraId = '${record.WorkHoursID}'
      `)

      if (!matchingRecords.length) {
        const ratesData = await pool.query(`(
          SELECT 
          customers.supportRate, 
          customers.consultantRate
          FROM tickets
            INNER JOIN customers ON customer=customers.customerId
          WHERE ticketId = '${record.TicketID}')
        `)
        const roleData = await pool.query(`
          SELECT role
          FROM employees
          WHERE microsoftId='${microsoftId}'
        `)
        const rates = ratesData[0]

        const role = roleData[0].role

        let rateMultiplier = 0

        //Check if time is between 8 and 17 for regular rates or not
        if (startTime.hour() >= 8 && startTime.hour() < 17) {
          rateMultiplier = 1
        } else {
          rateMultiplier = 2
        }

        let rate = 0

        if (role <= 1) {
          rate = rates.supportRate
        } else if (role >= 2) {
          rate = rates.consultantRate
        }

        rate *= rateMultiplier

        try {
          await pool.query(`
              INSERT INTO workhourrecords (
                ateraId, ticketId, employee, billable, rate, description,
                startTime, endTime, time, timeRounded
                )
                VALUES (
                  ${record.WorkHoursID},
                  ${ticketId},
              '${microsoftId}',
              ${record.Billiable},
              ${rate},
              '${parseQueryString(record.Description)}',
              '${startTime.format('YYYY-MM-DD HH:mm:ss')}',
              '${endTime.format('YYYY-MM-DD HH:mm:ss')}',
              '${formatSecondsAsTime(seconds)}',
              '${formatSecondsAsTime(roundToNearest15(seconds))}'
              )
              `)
        } catch (error) {
          console.error(error)
        }
        // If we already have the record in the database, update their starting and ending times.
      } else {
        //If record hasn't been edited by shell. Update it.
        if (matchingRecords[0].edited == 0) {
          pool
            .query(
              `
              UPDATE workhourrecords
              SET
              startTime = '${startTime.format('YYYY-MM-DD HH:mm:ss')}',
                    endTime = '${endTime.format('YYYY-MM-DD HH:mm:ss')}',
                    time = '${formatSecondsAsTime(seconds)}',
                    timeRounded = '${formatSecondsAsTime(roundToNearest15(seconds))}'
                  WHERE ateraId = '${record.WorkHoursID}'
                  `,
            )
            .catch((error) => {
              console.error(error)
            })
        }
      }
    }
  }
  console.log('Finished updating workhours')
}

async function testStuff(ticketId: any) {
  console.log(ticketId)
  let workHourRecords = await getAteraData(`tickets/${ticketId}/workhoursrecords`, 'multiple')

  for (let record of workHourRecords) {
    const startTime: dayjs.Dayjs = dayjs(record.StartWorkHour).tz('Europe/Copenhagen')
    const endTime: dayjs.Dayjs = dayjs(record.EndWorkHour).tz('Europe/Copenhagen')
    const seconds = endTime.diff(startTime, 'second')

    const microsoftId = await getMicrosoftIdByEmail(record.TechnicianEmail)
    if (microsoftId == null) break

    const matchingRecords = await pool.query(`
      SELECT * FROM workhourrecords
      WHERE ateraId = '${record.WorkHoursID}'
    `)

    if (!matchingRecords.length) {
      const ratesData = await pool.query(`(
        SELECT 
        customers.supportRate, 
        customers.consultantRate
        FROM tickets
          INNER JOIN customers ON customer=customers.customerId
        WHERE ticketId = '${record.TicketID}')
      `)
      const roleData = await pool.query(`
        SELECT role
        FROM employees
        WHERE microsoftId='${microsoftId}'
      `)
      const rates = ratesData[0]

      const role = roleData[0].role

      let rateMultiplier = 0

      //Check if time is between 8 and 17 for regular rates or not
      if (startTime.hour() >= 8 && startTime.hour() < 17) {
        rateMultiplier = 1
      } else {
        rateMultiplier = 2
      }

      let rate = 0

      if (role <= 1) {
        rate = rates.supportRate
      } else if (role >= 2) {
        rate = rates.consultantRate
      }

      rate *= rateMultiplier

      try {
        await pool.query(`
            INSERT INTO workhourrecords (
              ateraId, ticketId, employee, billable, rate, description,
              startTime, endTime, time, timeRounded
              )
              VALUES (
                ${record.WorkHoursID},
                ${ticketId},
            '${microsoftId}',
            ${record.Billiable},
            ${rate},
            '${parseQueryString(record.Description)}',
            '${startTime.format('YYYY-MM-DD HH:mm:ss')}',
            '${endTime.format('YYYY-MM-DD HH:mm:ss')}',
            '${formatSecondsAsTime(seconds)}',
            '${formatSecondsAsTime(roundToNearest15(seconds))}'
            )
            `)
      } catch (error) {
        console.error(error)
      }
      // If we already have the record in the database, update their starting and ending times.
    } else {
      //If record hasn't been edited by shell. Update it.
      if (matchingRecords[0].edited == 0) {
        pool
          .query(
            `
            UPDATE workhourrecords
            SET
            startTime = '${startTime.format('YYYY-MM-DD HH:mm:ss')}',
                  endTime = '${endTime.format('YYYY-MM-DD HH:mm:ss')}',
                  time = '${formatSecondsAsTime(seconds)}',
                  timeRounded = '${formatSecondsAsTime(roundToNearest15(seconds))}'
                WHERE ateraId = '${record.WorkHoursID}'
                `,
          )
          .catch((error) => {
            console.error(error)
          })
      }
    }
  }
}

testStuff(304310).then((res) => {
  console.log(res)
})

export async function syncSubscriptions() {
  const maxDate = knexClient('vmm').max('date')
  const vmmData: any = await knexClient('vmm')
    .select('cloud', 'date', 'vmcount', 'cpucount', 'storagegb', 'memorygb')
    .where('date', maxDate)
    .andWhereNot('cloud', '')

  let errors = []
  let changes = []

  // For each row of data meaning every individual customer's data
  for (const vmm of vmmData) {
    let customerId = vmm.cloud.substring(vmm.cloud.search(/\(([^()]*)\)/) + 1, vmm.cloud.length - 1)
    const vmmInstances = await getVMMInstancesByCustomer(customerId)

    let vmmTypes = [
      {
        column: 'vmcount',
        engine: 2,
      },
      {
        column: 'cpucount',
        engine: 3,
      },
      {
        column: 'memorygb',
        engine: 4,
      },
      {
        column: 'storagegb',
        engine: 5,
      },
    ]
    for (const vmmType of vmmTypes) {
      const foundSubs = vmmInstances.filter((obj) => obj.vmmColumn == vmmType.column)
      if (!foundSubs) {
        errors.push(
          `VMM shows active ${vmmType} for customer, but no instance of related subscriptions.`,
        )
      } else {
        for (const sub of foundSubs) {
          const post = await getSubInstancePost(sub.latestPostId)
          if (post.units != vmm[sub.vmmColumn]) {
            await knexClient('subscriptioninstanceposts')
              .where('id', post.id)
              .update({
                endDate: dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
              })
            await knexClient('subscriptioninstanceposts').insert({
              instance: sub.id,
              units: vmm[sub.vmmColumn],
              unitPrice: post.unitPrice,
              startDate: dayjs().format('YYYY-MM-DD'),
              endDate: post.endDate,
            })
            changes.push(
              `Subscription "${sub.name}" automatically synchronized with VMM. VMM shows: ${
                vmm[sub.vmmColumn]
              } units. Subscription showed: ${post.units} units.`,
            )
          }
        }
      }
    }
    if (changes.length) {
      let text = ''

      for (const change of changes) {
        text = text + change + '<br>'
      }

      let salesPersonEmail = await knexClient('customers')
        .join('employees', 'employees.microsoftId', 'customers.employee')
        .select('employees.email')
        .where({
          customerId: customerId,
        })
        .first()
      if (salesPersonEmail.email) {
        sendEmail(
          salesPersonEmail.email,
          `[Shell Alert]: ${vmm.cloud} - Automatic changes made`,
          text,
        )
      } else {
        console.error('No salesperson email available')
      }
    }
    if (errors.length) {
      let text = ''

      for (const error of errors) {
        text = text + error + '<br>'
      }
      sendEmail(
        'subscounterror@ITConfidenceDK.onmicrosoft.com',
        `[Shell Alert]: ${vmm.cloud} - VMM errors found while syncing subscriptions`,
        text,
      )
    }
    changes = []
    errors = []
  }
}

async function ensureSubscriptionExists(sku: string) {
  console.log(`Ensuring subscription exists for ${sku}`)
  const dbSub = await db.getSubscriptionBySKU(sku)
  const sub = await streamOne.getProductBySKU(sku)
  if (!dbSub) {
    // Check that the subscription doesn't exist in the database.

    if (sub) {
      // Check that the subscription exist in the StreamOne API.
      const subPrice = await streamOne.getProductPricingBySKU({
        sku: sku,
        quantity: Number(sub.qtyMin),
      })

      if (subPrice.msrp != 0) {
        const unitPrice = Number(subPrice.msrp) / Number(sub.qtyMin)

        let paymentFrequency = 4

        switch (sub.billingType) {
          case 'Monthly':
            paymentFrequency = 4
            break
          case 'Annual':
            paymentFrequency = 8
            break
        }
        try {
          await createSubscription({
            product: 40011000,
            name: `${sub.skuName} - ${sub.billingType}`,
            billingEngine: 6,
            description: sub.description,
            price: unitPrice,
            startDate: dayjs().format('YYYY-MM-DD'),
            group: 13,
            paymentFrequencyId: paymentFrequency,
            ticketFrequencyId: 1,
            sku: sub.sku,
          })
        } catch (err) {
          console.error(err)
          throw err
        }
      }
    } else {
      // sendEmail(
      //   'joti@itconfidence.dk',
      //   '[Shell Alert]: SKU missing from StreamOne',
      //   `Shell tried to insert a subscription with SKU: ${sku}, but couldn't fetch subscription information from the StreamOne API`,
      // )
    }
    // Subscription exists, so we sync the price
  }
}

// streamOne.getSubscriptionsByCustomer('034d9169-3d19-4ae4-bb45-29f2cbb738fa').then((res) => {
//   const append = appendAddons(res)
//   console.log(parseCSPSubData(append))
// })

function appendAddons(cspData: any) {
  for (const cspRaw of cspData) {
    const csp: any = Object.values(cspRaw)[0]
    if (csp.addOns) {
      for (let addOn of csp.addOns) {
        addOn.lineStatus = addOn.addOnStatus
        addOn.subscriptionHistory = addOn.additionalData.subscriptionHistory
        cspData.push(addOn)
      }
    }
  }
  return cspData
}

export async function syncCSPSubscriptions() {
  console.log('Beginning CSP sync')
  let changes = []
  try {
    const customers = await getCustomers()
    for (const customer of customers.collection) {
      if (customer.microsoftId) {
        console.log(`Syncing ${customer.name}`)
        let cspData = await streamOne.getSubscriptionsByCustomer(customer.microsoftId)
        if (cspData) {
          const appended = appendAddons(cspData)
          const subs = parseCSPSubData(appended)
          for (const sub of subs) {
            try {
              await ensureSubscriptionExists(sub.sku)
              const dbSubInst = await db.getSubscriptionInstancesBySKU(customer.customerId, sub.sku)
              if (dbSubInst) {
                const latestPost: any = await knexClient('subscriptioninstanceposts')
                  .select('id', 'units', 'instance', 'unitPrice', 'startDate', 'endDate')
                  .where('instance', dbSubInst.id)
                  .orderBy('id', 'desc')
                  .first()
                if (sub.lineStatus != 'inactive') {
                  if (latestPost.units !== sub.quantity) {
                    await knexClient('subscriptioninstanceposts')
                      .where('id', latestPost.id)
                      .update({
                        endDate: dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
                      })
                    await knexClient('subscriptioninstanceposts').insert({
                      instance: dbSubInst.id,
                      units: sub.quantity,
                      unitPrice: latestPost.unitPrice,
                      startDate: dayjs().format('YYYY-MM-DD'),
                      endDate: latestPost.endDate,
                    })
                    changes.push(
                      `Subscriptioninstance ${dbSubInst.id}: "${dbSubInst.name}" automatically synchronized with StreamOne. 
                      StreamOne shows: ${sub.quantity} units. Subscription showed: ${latestPost.units} units.`,
                    )
                  }
                } else {
                  if (!latestPost.endDate) {
                    let lastUpdated = dayjs(sub.updatedDate)
                    let employeeName: string
                    for (const change of sub.subscriptionHistory) {
                      if (lastUpdated.isBefore(dayjs(change.createdOn))) {
                        lastUpdated = dayjs(change.createdOn)
                        employeeName = change.createdBy
                      }
                    }

                    knexClient('subscriptioninstanceposts')
                      .where({ id: latestPost.id })
                      .update({ endDate: lastUpdated.format('YYYY-MM-DD') })
                      .then(async () => {
                        changes.push(
                          `Subscriptioninstance ${dbSubInst.id}: "${dbSubInst.name}" automatically closed since it's inactive.`,
                        )
                        const employeeId = await getEmployeeIdByName(employeeName)

                        if (employeeId) {
                          db.createLog({
                            customer: customer.customerId,
                            type: 2,
                            employee: employeeId,
                            message: `Subscription ${dbSubInst.name} with id: ${
                              dbSubInst.id
                            } was set as inactive on ${lastUpdated.format(
                              'YYYY-MM-DD HH:mm:ss',
                            )} and has been closed.`,
                          })
                        } else {
                          db.createLog({
                            customer: customer.customerId,
                            type: 2,
                            message: `Subscription ${dbSubInst.name} with id: ${
                              dbSubInst.id
                            } was set as inactive in StreamOne on ${lastUpdated.format(
                              'YYYY-MM-DD HH:mm:ss',
                            )} and has been closed.`,
                          })
                        }
                      })
                  }
                }
              } else {
                if (sub.lineStatus == 'active') {
                  try {
                    const skuSub = await knexClient('subscriptions')
                      .select()
                      .where('sku', sub.sku)
                      .first()
                    if (skuSub) {
                      await createSubscriptionInstance(customer.customerId, {
                        name: sub.name ? sub.name : sub.skuName,
                        startDate: dayjs(sub.createdDate).format('YYYY-MM-DD'),
                        units: sub.quantity,
                        unitPrice: skuSub.price,
                        subscriptionId: skuSub.id,
                      })
                      // db.createLog({
                      //   customer: customer.customerId,
                      //   type: 2,
                      //   message: `Subscription ${dbSubInst.name} with id: ${
                      //     dbSubInst.id
                      //   } was set as inactive in StreamOne on ${lastUpdated.format(
                      //     'YYYY-MM-DD HH:mm:ss',
                      //   )} and has been closed.`,
                      // })
                    }
                  } catch (err) {
                    console.error(err)
                  }
                }
              }
            } catch (err) {
              throw err
            }
          }
        }
      }
      if (changes.length) {
        console.log(customer.name)
        console.log(changes)
        let text = ''
        for (const change of changes) {
          text = text + change + '<br>'
        }
        let salesPersonEmail = await knexClient('customers')
          .join('employees', 'employees.microsoftId', 'customers.employee')
          .select('employees.email')
          .where({
            customerId: customer.customerId,
          })
          .first()
        if (salesPersonEmail.email) {
          // sendEmail(
          //   'macl@itconfidence.dk',
          //   `[Shell Alert]: ${customer.name} - Automatic changes made`,
          //   text,
          // )
          sendEmail(
            salesPersonEmail.email,
            `[Shell Alert]: ${customer.name} - Automatic changes made`,
            text,
          )
        } else {
          console.error('No salesperson email available')
        }
      }
      changes = []
    }
  } catch (err) {
    throw err
  }
  console.log('Finished')
}

function parseCSPSubData(subs: any[]) {
  let returnObject: any[] = []
  for (const sub of subs) {
    let values = sub
    if (!sub.sku) values = Object.values(sub)[0]

    const foundIndex = returnObject.findIndex((obj) => obj.sku == values.sku)
    if (foundIndex >= 0) {
      returnObject[foundIndex].quantity += values.quantity
    } else {
      returnObject.push(values)
    }
  }
  return returnObject
}

async function getEmployeeIdByName(name: string): Promise<string | undefined> {
  const employee = await knexClient('employees').select().where({ name: name }).first()
  if (employee) return employee.microsoftId

  return undefined
}

export async function syncAndGenerateMissingCSPSubscriptions() {
  console.log('Fetch product')
  const microsoftProducts = await streamOne.getProductsByVendorId({
    vendorIds: [397],
  })
  // console.log('Fetch price')
  // const pricing = await streamOne.getProductPricing([397])
  // console.log(JSON.stringify(pricing))

  for (const msProduct of microsoftProducts) {
    let products = []
    products.push(msProduct) // Push the current product to an array of products

    if (msProduct.addOns) {
      // If the current product has any addOns, push them to the same products array
      for (const addon of msProduct.addOns) products.push(addon)
    }

    // Iterate over each product
    for (let product of products) {
      // Get the price for the specific product
      const pricing = await streamOne.getProductPricingBySKU({
        sku: product.sku,
        quantity: product.qtyMin,
      })
      if (pricing) {
        product.price = pricing.msrp / product.qtyMin

        try {
          const sub = await db.getSubscriptionBySKU(product.sku)
          let paymentFrequency = 4

          switch (product.billingType) {
            case 'Monthly':
              paymentFrequency = 4
              break
            case 'Annual':
              paymentFrequency = 8
              break
          }

          if (!sub) {
            if (product.price && product.price != 0)
              console.log('Inserting subscription with SKU: ' + product.sku)
            db.insertSubscription({
              product: 40011000,
              name: `${product.skuName} - ${product.billingType || 'AddOn'}`,
              description: product.description,
              sku: product.sku,
              active: true,
              billingEngine: 6,
              paymentFrequency: paymentFrequency,
              ticketFrequency: 1,
              price: product.price,
              startDate: dayjs().format('YYYY-MM-DD'),
              subscriptionGroup: 13,
            })
          } else {
            let tempSub = sub
            tempSub.price = product.price

            console.log('Updating subscription price for ' + product.sku)
            await knexClient('subscriptions').update(tempSub).where({ id: tempSub.id })
          }
        } catch (err) {
          console.error(err)
        }
      }
    }
  }
}

export async function syncContactsWithAzure() {
  const customers = await getCustomers()
  for (const customer of customers.collection) {
    if (customer.microsoftId) {
      getUsersByTenantId(customer.microsoftId).then(async (res) => {
        console.log(JSON.stringify(res))
        for (const user of res) {
          if (user.Mail == 'itctestapi@privatbo.dk') console.log(user)
          await syncO365Id(customer, user)
          await syncContactWithAzure(user['O365 ID'], user)
        }
      })
    }
  }
}

async function syncO365Id(customer: any, user: User) {
  try {
    const contact = await knexClient('contacts').select().where({ email: user.Mail }).first()
    if (contact) {
      await knexClient('contacts').update({ o365Id: user['O365 ID'] }).where({ email: user.Mail })
    } else {
      // If there is no contact with that email in the database, create it.
      if (user.Mail && user.Givenname && user.Surname) {
        let contactObject: any = {
          businessNumber: customer.customerId,
          email: user.Mail,
          firstName: String(user.Givenname),
          lastName: String(user.Surname),
          name: customer.name,
          o365Id: user['O365 ID'],
        }

        if (user.JobTitle) contactObject.title = user.JobTitle
        if (user.MobilePhone) contactObject.phone = parsePhoneAsE164(user.MobilePhone)

        if (!contact.ateraId) createContact(contactObject) // This is such a horrible function that doesn't work properly.
      }
    }
  } catch (err) {
    console.error(err)
  }
}

async function syncContactWithAzure(o365Id: string, user: User) {
  try {
    await knexClient('contacts')
      .update({ firstName: user.Givenname, lastName: user.Surname, jobTitle: user.JobTitle })
      .where({ o365Id: user['O365 ID'] })

    const dbContact = await knexClient('contacts').select('*').where({ o365Id: o365Id }).first()
    if (dbContact) {
      if (user.MobilePhone) {
        const number = await knexClient('contactphonenumbers')
          .select('phone')
          .where({ phone: parsePhoneAsE164(user.MobilePhone) })
          .first()

        if (!number) {
          await knexClient('contactphonenumbers').insert({
            contact: dbContact.contactId,
            phone: parsePhoneAsE164(user.MobilePhone),
            name: 'Mobile Phone (Azure)',
          })
        }
      }
      if (user.BusinessPhone && user.BusinessPhone[0]) {
        const number = await knexClient('contactphonenumbers')
          .select('phone')
          .where({ phone: parsePhoneAsE164(user.BusinessPhone[0]) })
          .first()
        if (!number) {
          await knexClient('contactphonenumbers').insert({
            contact: dbContact.contactId,
            phone: parsePhoneAsE164(user.BusinessPhone[0]),
            name: 'Business Phone (Azure)',
          })
        }
      }
    }
  } catch (err) {
    console.error(err)
  }
}

async function getVMMInstancesByCustomer(customerId: number) {
  const today = dayjs().format('YYYY-MM-DD')
  const instances = await knexClient('subscriptioninstances as inst')
    .join('subscriptions as subs', 'inst.subscription', 'subs.id')
    .join('subscriptioninstanceposts as posts', 'inst.id', 'posts.instance')
    .max('posts.id as latestPostId')
    .select('inst.id', 'inst.name', 'subs.id as subscriptionId', 'subs.billingEngine')
    .whereIn('subs.billingEngine', [2, 3, 4, 5])
    .where((bd) => {
      bd.whereNot('posts.endDate', '<=', today).orWhereNull('posts.endDate')
    })
    .where({ customer: customerId })
    .groupBy('inst.id')

  for (const sub of instances) {
    switch (sub.billingEngine) {
      case 2:
        sub.vmmColumn = 'vmcount'
        break
      case 3:
        sub.vmmColumn = 'cpucount'
        break
      case 4:
        sub.vmmColumn = 'memorygb'
        break
      case 5:
        sub.vmmColumn = 'storagegb'
        break
    }
  }
  return instances
}

async function getSubInstancePost(postId: number) {
  return await knexClient('subscriptioninstanceposts as posts')
    .select('id', 'instance', 'units', 'unitPrice', 'startDate', 'endDate')
    .where({ id: postId })
    .first()
}

function roundToNearest15(seconds: number) {
  return Math.ceil(seconds / 900) * 900 //15 minutes in seconds is 900
}

export async function getAteraData(endpoint: string, type: string) {
  let results: any = []
  let url = `https://app.atera.com/api/v3/${endpoint}` //50 items per page is maximum in the Atera API
  do {
    // Always get the first page of data.
    try {
      const data = await axios.get(url, ateraConfig)
      if (data.data.nextLink == null) {
        url = ''
      } else {
        url = data.data.nextLink
      }
      if (type == 'single') {
        results = results.concat(data.data)
      } else if (type == 'multiple') {
        results = results.concat(data.data.items)
      }
    } catch (error) {
      console.log(error)
    }
    console.log(url)
  } while (url)
  return await results
}

export async function getEconomicData(endpoint: string) {
  let results: any = []
  let url = `https://restapi.e-conomic.com/${endpoint}?skippages=0&pagesize=1000`
  do {
    // Always get the first page of data.
    const data = await axios.get(url, economicConfig)
    if (data.data.pagination == null) {
      url = ''
    } else {
      url = data.data.pagination.nextPage
    }
    results = results.concat(data.data.collection)
  } while (url)
  return await results
}
