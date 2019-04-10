/**
 * @file Manages the wrapper of SINESP's search for plates
 *
 * @author Lucas Bernardo
 *
 * @requires NPM:xml2js
 * @requires NPM:axios
 * @requires NPM:https-proxy-agent
 */

const { createHmac } = require('crypto');
const { promisify } = require('util');

const { parseString, Builder } = require('xml2js');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');

const promisedParseString = promisify(parseString);

/**
 * The accepted format: AAA0000
 *
 * @constant
 *
 * @type {RegExp}
 */
const PLATE_FORMAT = /^[a-zA-Z]{3}[0-9]{4}$/im;
const SPECIAL = /[^a-zA-Z0-9]/i;

const DEFAULT = {
  host: 'cidadao.sinesp.gov.br',
  endpoint: '/sinesp-cidadao/mobile/consultar-placa/',
  serviceVersion: 'v4',
  androidVersion: '8.1.0',
  secret: 'g8LzUadkEHs7mbRqbX5l',
  timeout: 0,
  maximumRetry: 0,
  proxy: {},
};

let opts = {};

/**
 * Validate the format of the plate informed
 *
 * @param {string} plate - The informed plate
 *
 * @returns {Promise<string>} Represents the plate without special characters
 *
 * @private
 */
const validate = async (plate) => {
  const plateToUse = plate.replace(SPECIAL, '');

  if (!PLATE_FORMAT.test(plateToUse)) {
    throw new Error('Formato de placa inválido! Utilize o formato "AAA9999" ou "AAA-9999".');
  }

  return plateToUse;
};

/**
 * Transforms the answered XML in a JSON
 *
 * @param {string} returnedXML - The answered XML
 *
 * @returns {Promise<object>} Represents the JSON filled with the XML response
 *
 * @private
 */
const normalize = async (returnedXML) => {
  const { 'soap:Envelope': { 'soap:Body': { 'ns2:getStatusResponse': { return: envelope } } } } = await promisedParseString(returnedXML, { explicitArray: false });

  if (parseInt(envelope.codigoRetorno, 10) !== 0) {
    throw Error(envelope.mensagemRetorno);
  }

  return envelope;
};

/**
 * Generates a octet from 1 to 255
 *
 * @returns {Promise<number>} Represents a random octet
 *
 * @private
 */
const generateRandomOctet = async () => (Math.floor(Math.random() * 255) + 1);

/**
 * Generates a random IP address
 *
 * @returns {Promise<string>} Represents a random IP address
 *
 * @private
 */
const generateIPAddress = async () => {
  const [octet1, octet2, octet3, octet4] = await Promise.all([
    generateRandomOctet(),
    generateRandomOctet(),
    generateRandomOctet(),
    generateRandomOctet(),
  ]);

  return `${octet1}.${octet2}.${octet3}.${octet4}`;
};

/**
 * Generates the coordinates used in the request
 *
 * @returns {Promise<number>} Represents a random coordinate
 *
 * @private
 */
const generateCoordinate = async () => {
  const seed = 2000 / Math.sqrt(Math.random());

  return seed * Math.sin(2 * 3.141592654 * Math.random());
};

/**
 * Generates a random latitude
 *
 * @returns {Promise<number>} Represents a random latitude
 *
 * @private
 */
const generateLatitude = async () => await generateCoordinate() - 38.5290245;

/**
 * Generates a random longitude
 *
 * @returns {Promise<number>} Represents a random longitude
 *
 * @private
 */
const generateLongitude = async () => await generateCoordinate() - 3.7506985;

/**
 * Create the token using 'SHA-1' algoritm based on the plate and the secret
 *
 * @param {string} plate - The plate to be searched
 *
 * @returns {Promise<string>} Represents the created token
 *
 * @private
 */
const generateToken = async (plate) => {
  const secret = `#${opts.androidVersion}#${opts.secret}`;

  return createHmac('sha1', `${plate}${secret}`)
    .update(plate)
    .digest('hex');
};

/**
 * Generates the date formatted by 'YYYY-MM-DD HH:mm:ss'
 *
 * @param {Date} date - The date to be formatted
 *
 * @returns {Promise<string>} Represents the formatted date
 *
 * @private
 */
const formatDate = async (date) => {
  const year = date.getFullYear();
  const month = (`00${date.getMonth() + 1}`).slice(-2);
  const day = (`00${date.getDate()}`).slice(-2);
  const hour = (`00${date.getHours()}`).slice(-2);
  const minute = (`00${date.getMinutes()}`).slice(-2);
  const second = (`00${date.getSeconds()}`).slice(-2);

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

/**
 * Waits a determined time to fulfill a Promise
 *
 * @param {number} ms - The milliseconds to fulfill the Promise
 *
 * @returns {Promise<any>} Represents the fulfilled time
 */
const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * Try to request the following URL using the maximumRetry option
 *
 * @param {string} url - The URL to connect
 * @param {object} options - The options to pass to axios
 * @param {number} [attempt=0] - The current attempt number
 * @param {number} [delay=0] - The time in milliseconds to wait before request
 *
 * @returns {Promise<*|void>} Represents the fulfilled request
 *
 * @private
 */
const retry = async (url, options, attempt = 0, delay = 0) => {
  try {
    await sleep(delay);
    const { data } = await axios.request({ url, ...options });

    return data;
  } catch (e) {
    if (attempt >= opts.maximumRetry) throw e;

    return retry(url, options, attempt + 1, (delay || 1000) * 2);
  }
};

/**
 * Send the request to SINESP's 'search by plate' service
 *
 * @param {string} data - The XML expected by SINESP's service
 *
 * @returns {Promise<object>} Represents the JSON filled with the SINESP's service response
 *
 * @private
 */
const request = async (data) => {
  const url = `https://${opts.host}${opts.endpoint}${opts.serviceVersion}`;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': 'SinespCidadao / 3.0.2.1 CFNetwork / 758.2.8 Darwin / 15.0.0',
    Host: opts.host,
  };

  const httpsAgent = opts.proxy.host ? new HttpsProxyAgent(`http://${opts.proxy.host}:${opts.proxy.port}`) : null;

  const response = await retry(url, {
    data,
    headers,
    httpsAgent,
    method: 'POST',
    timeout: opts.timeout,
  });

  return normalize(response);
};

/**
 * Generates the XML body in the format expected by the SINESP's service
 *
 * @param {string} plate - Treated and informed plate
 *
 * @returns {Promise<string>} Represents the filled XML to be sent
 *
 * @private
 */
const generateBody = async (plate) => {
  const builder = new Builder({ rootName: 'v:Envelope' });
  const plateToUse = await validate(plate);

  const [ip, latitude, longitude, token, date] = await Promise.all([
    generateIPAddress(),
    generateLatitude(),
    generateLongitude(),
    generateToken(plateToUse),
    formatDate(new Date()),
  ]);

  const body = {
    $: {
      'xmlns:v': 'http://schemas.xmlsoap.org/soap/envelope/',
    },
    'v:Header': {
      b: 'LGE Nexus 5',
      c: 'ANDROID',
      d: opts.androidVersion,
      e: '4.3.2',
      f: ip,
      g: token,
      h: longitude,
      i: latitude,
      j: '',
      k: '',
      l: date,
      m: '8797e74f0d6eb7b1ff3dc114d4aa12d3',
    },
    'v:Body': {
      $: {
        'xmlns:n0': 'http://soap.ws.placa.service.sinesp.serpro.gov.br/',
      },
      'n0:getStatus': {
        a: plateToUse,
      },
    },
  };

  return builder.buildObject(body);
};

/**
 * Searches a Vehicle by plate
 *
 * @example
 * // 'vehicle' is set to the response object
 * let vehicle = await search('AAA111');
 *
 * @param {string} plate - The plate of the vehicle to be searched
 *
 * @returns {Promise<object>} Represents the vehicle identified by the plate
 */
const search = async (plate = '') => {
  const body = await generateBody(plate);

  return request(body);
};

/**
 * Configure the module
 *
 * @param {string} [host=cidadao.sinesp.gov.br] - Host of SINESP service
 * @param {string} [endpoint=/sinesp-cidadao/mobile/consultar-placa/] - Endpoint of SINESP service
 * @param {string} [serviceVersion=v4] - Service version of SINESP
 * @param {string} [androidVersion=8.1.0] - Android version to inform to the SINESP service
 * @param {string} [secret=g8LzUadkEHs7mbRqbX5l] - The secred used to encrypt the plate
 * @param {number} [timeout=0] - req/res timeout in ms, it resets on redirect.
 *                               0 to disable (OS limit applies)
 * @param {number} [maximumRetry=0] - Maximum retrys if the request fail
 * @param {object} [proxy={}] - The proxy object if exists
 *
 * @returns The module it self
 */
const configure = ({
  host,
  serviceVersion,
  androidVersion,
  endpoint,
  secret,
  timeout,
  maximumRetry,
  proxy = {},
} = {}) => {
  opts = {
    host: host || DEFAULT.host,
    endpoint: endpoint || DEFAULT.endpoint,
    serviceVersion: serviceVersion || DEFAULT.serviceVersion,
    androidVersion: androidVersion || DEFAULT.serviceVersion,
    secret: secret || DEFAULT.secret,
    timeout: timeout || DEFAULT.timeout,
    maximumRetry: maximumRetry || DEFAULT.maximumRetry,
    proxy: {
      host: proxy.host || DEFAULT.proxy.host,
      port: proxy.port || DEFAULT.proxy.port,
    },
  };

  return {
    configure,
    search,
  };
};

configure();

module.exports = {
  configure,
  search,
};
