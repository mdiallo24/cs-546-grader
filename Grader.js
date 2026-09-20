import fs from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { deepStrictEqual } from 'assert';
import { pathToFileURL } from 'url';
import { MongoClient, ObjectId } from 'mongodb';
import { FatalGraderError } from './Utils.js';
import { HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';

const entryPath = (entry) => entry.parentPath ?? entry.path;

/**
 * HTTP request verb
 * @typedef {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} Verb
 */

export const stringify = (obj, spacing = undefined) =>
  JSON.stringify(
    obj,
    (_, value) => {
      if (value instanceof ObjectId) return { oid: value.toString() };
      return value;
    },
    spacing,
  );
const pretty = (data) => stringify(data, 2);
const uid = (() => {
  let id = 0;
  return () => id++;
})();

/**
 * Do not instantiate this class. Extend it and implement
 * the testCases() method.
 */
export default class Grader {
  constructor(assignmentConfig) {
    assignmentConfig = assignmentConfig || {};
    this.requiredFiles = assignmentConfig.requiredFiles || [];
    this.requiredCollections = assignmentConfig.requiredCollections || [];
    this.defaultStartScript = assignmentConfig.startScript || 'node app.js';
    this.runStartScript = assignmentConfig.runStartScript;
    this.checkPackage = assignmentConfig.checkPackage ?? true;
    this.hasDatabase = assignmentConfig.hasDatabase;
    this.printObjectIdMessage = assignmentConfig.printObjectIdMessage ?? true;
    this.connectionString =
      assignmentConfig.connectionString || 'mongodb://localhost:27017/';
    this.packageJson = null;
    this.hadModules = false;
    this.directory = 'current_submission';
    this.author = '';
    this.module = true;
    this.startScript = null;
    this.subprocess = null;
    this.subprocessClosed = true;
    this.db = null;
    this.score = 100;
    this.comments = [];
    this.uid = uid();
  }

  /**
   * Deduct points from the student's grade.
   * @param {number} points Points to deduct
   * @param {string} reason Reason for deduction
   * @param {string} [error] Associated error message
   */
  deductPoints(points, reason, error) {
    this.score -= points;
    if (this.score < 0) this.score = 0;
    this.comments.push(
      `-${points}; ${reason}${error ? '\n' + error.toString() : ''}`,
    );
  }

  /**
   * Run a deep equality assertion test case.
   * @param {number} points Points the test case is worth
   * @param {string} message Message to print before error text
   * @param {(()=>T)} testCase The test case, should return the same type as `expectedValue`
   * @param {T} expectedValue The anticipated result of `testCase`
   */
  async assertDeepEquals(points, message, testCase, expectedValue) {
    let actual;
    try {
      actual = await testCase();
    } catch (e) {
      this.deductPoints(
        points,
        `${message}; Error thrown on valid input.`,
        e.toString(),
      );
      return;
    }

    try {
      deepStrictEqual(actual, expectedValue, 'Expected strict deep equality');
    } catch (e) {
      const findAllObjectIdsInArray = (arr) => {
        let newArr = [];
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (
            ObjectId.isValid(item) &&
            typeof item === 'object' &&
            item._bsontype === 'ObjectId'
          ) {
            newArr.push(`[${i}]`);
          } else if (Array.isArray(item)) {
            let res = findAllObjectIdsInArray(item);
            newArr.push(...res.map((subItem) => `[${i}]${subItem}`));
          } else if (item instanceof Object) {
            let res = findAllObjectIdsInObj(item);
            newArr.push(...res.map((subItem) => `[${i}]${subItem}`));
          }
        }
        return newArr;
      };

      const findAllObjectIdsInObj = (obj) => {
        let newArr = [];
        for (let key in obj) {
          if (
            ObjectId.isValid(obj[key]) &&
            typeof obj[key] === 'object' &&
            obj[key]._bsontype === 'ObjectId'
          ) {
            newArr.push(`.${key}`);
          } else if (Array.isArray(obj[key])) {
            let res = findAllObjectIdsInArray(obj[key]);
            newArr.push(...res.map((subItem) => `.${key}${subItem}`));
          } else if (obj[key] instanceof Object) {
            let res = findAllObjectIdsInObj(obj[key]);
            newArr.push(...res.map((subItem) => `.${key}${subItem}`));
          }
        }
        return newArr;
      };

      // Check if ObjectId's are passed in. Lab specs usually require ObjectId's to be stringified.
      // Since the stringification between "expected" and "result" is misleading, this gives a note
      //   to the student urging them to check that their obj_id
      let keys = [];
      if (this.printObjectIdMessage) {
        if (Array.isArray(actual)) {
          keys = findAllObjectIdsInArray(actual);
        } else if (actual instanceof Object) {
          keys = findAllObjectIdsInObj(actual);
        }
      }
      keys = keys.map((key) => key.replace(/^\./, ''));

      const objIdErrMsg = keys.length
        ? ` ObjectId type found at the following key(s) instead of type string: "${keys.join('", "')}"`
        : '';

      this.deductPoints(
        points,
        `${message}; Unexpected results.${objIdErrMsg}`,
        `Received: ${pretty(actual)}\nExpected: ${pretty(expectedValue)}`,
      );
    }
  }

  /**
   * Run a deep equality assertion test case with multiple acceptable outputs.
   * @param {number} points Points the test case is worth
   * @param {string} message Message to print before error text
   * @param {(()=>T)} testCase The test case, should return the same type as an `expectedValues` element
   * @param {T[]} expectedValues An array of all possible anticipated results of `testCase`
   */
  async assertDeepEqualsOptions(points, message, testCase, expectedValues) {
    let actual;
    try {
      actual = await testCase();
    } catch (e) {
      this.deductPoints(
        points,
        `${message}; Error thrown on valid input.`,
        e.toString(),
      );
      return;
    }

    for (const expectedValue of expectedValues) {
      try {
        deepStrictEqual(actual, expectedValue);
        return;
      } catch {}
    }
    this.deductPoints(
      points,
      `${message}; Unexpected results.`,
      `Received: ${pretty(actual)}\nExpected one of the following:\n- ` +
        expectedValues.map(pretty).join('\n- '),
    );
  }

  /**
   * Asserts that a test case throws an error. Optionally a specific
   * error message and error type can be specified.
   * @param {number} points Points the test case is worth
   * @param {string} message Message to print before error text
   * @param {(()=>T)} testCase The test case, should throw the same type `expectedType`
   * @param {string} [expectedMessage] Optional specific error message
   * @param {number} [messagePoints] Points to deduct for an incorrect error message
   * @param {Error} [expectedType] Optional specific error type
   * @param {number} [typePoints] Points to deduct for an incorrect error type
   */
  async assertThrows(
    points,
    message,
    testCase,
    expectedMessage,
    messagePoints,
    expectedType,
    typePoints,
  ) {
    if (expectedMessage && typeof messagePoints !== 'number')
      throw new TypeError(
        'If expectedMessage is provided, messagePoints must be provided as well.',
      );
    if (expectedType && typeof typePoints !== 'number')
      throw new TypeError(
        'If expectedType is provided, typePoints must be provided as well.',
      );
    try {
      const result = await testCase();
      this.deductPoints(
        points,
        `${message}; Expected an error to be thrown, got a result instead.`,
        pretty(result),
      );
    } catch (e) {
      if (!expectedMessage && !expectedType) return;
      let deducted = 0;
      if (expectedMessage) {
        const errorMessage = typeof e === 'string' ? e : e.message;
        if (errorMessage.trim() !== expectedMessage.trim()) {
          this.deductPoints(
            messagePoints,
            `${message}; Encountered unexpected error message.`,
            `- Expected: ${expectedMessage}\n- Received: ${errorMessage}`,
          );
          deducted = messagePoints;
        }
      }
      if (expectedType && !(e instanceof expectedType)) {
        // Prevent cumulative deductions from going above
        // the total test case points
        if (typePoints + deducted > points) typePoints -= points - deducted;
        this.deductPoints(
          typePoints,
          `${message}; Encountered unexpected error type.`,
          `- Expected: ${expectedType.name || typeof expectedType}\n- Received: ${e.name || typeof e}`,
        );
      }
    }
  }

  /**
   * Make a request and get the response status and body.
   * @param {string} url The URL to make a request to
   * @param {Verb} [method] Request method to use (default 'GET')
   * @param {*} [body] Request body (automatically stringified if necessary)
   * @returns {Promise<[number,string]>}
   */
  async request(url, method = 'GET', body = '') {
    const options = { method: method };
    if (typeof body !== 'string') {
      options.headers = {
        'Content-Type': 'application/json',
      };
      body = pretty(body);
    }
    if (method !== 'GET' && body) options.body = body;
    try {
      const res = await fetch(url, options);
      return [res.status, await res.text()];
    } catch (e) {
      if (e instanceof TypeError)
        throw Error(`Could not complete request: ${method} ${url}
Server either didn't start, is at an unexpected URL, or crashed during the previous test case.`);
      else throw e;
    }
  }

  /**
   * Asserts that a response is ok (status 200) and has the specified body.
   * @param {number} points Points the test case is worth
   * @param {string} url URL to request
   * @param {Verb} method Request method to use
   * @param {*} body Request body (stringified automatically if needed)
   * @param {*} expectedValue Expected response body (can be any type)
   */
  async assertRequestDeepEquals(points, url, method, body, expectedValue) {
    const testCaseText = `${method.toUpperCase()} ${url}`;
    const [status, text] = await this.request(url, method, body);
    if (status !== 200) {
      this.deductPoints(
        points,
        testCaseText,
        `Route did not return an OK (200) status code.\nReceived: ${status}`,
      );
      return;
    }
    let actual = text;
    if (typeof expectedValue !== 'string') {
      try {
        actual = JSON.parse(actual);
      } catch (e) {
        this.deductPoints(
          points,
          testCaseText,
          `Invalid response body:\n${text}`,
        );
        return;
      }
    }
    await this.assertDeepEquals(
      points,
      testCaseText,
      () => actual,
      expectedValue,
    );
  }

  /**
   * Asserts that a response is ok (status 200) and has the specified body.
   * Ignores the `_id` key while checking equality, then returns the value
   * of it.
   * @param {number} points Points the test case is worth
   * @param {string} url URL to request
   * @param {Verb} method Request method to use
   * @param {*} body Request body (stringified automatically if needed)
   * @param {*} expectedValue Expected response body (can be any type)
   * @return {Promise<string>} The value of the `_id` property
   */
  async assertRequestDeepEqualsWithoutId(
    points,
    url,
    method,
    body,
    expectedValue,
  ) {
    const testCaseText = `${method.toUpperCase()} ${url}`;
    const [status, text] = await this.request(url, method, body);
    if (status !== 200) {
      this.deductPoints(
        points,
        testCaseText,
        `Route did not return an OK (200) status code.`,
      );
      return;
    }
    let actual = text;
    try {
      actual = JSON.parse(actual);
    } catch (e) {
      this.deductPoints(
        points,
        testCaseText,
        `Invalid response body:\n${text}`,
      );
      return;
    }
    return await this.assertWithoutId(
      points,
      testCaseText,
      () => actual,
      expectedValue,
      this.assertDeepEquals,
    );
  }

  /**
   * Runs a provided assertion, removing the _id attribute from the result
   * of `testCase()` first and then returning it after the assertion completes.
   * @param {number} points Points the test case is worth.
   * @param {string} message Message to print before error text.
   * @param {*} testCase Test case to post-process.
   * @param {*} expectedValue Expected value(s) to pass to the assertion
   * @param {*} assertion
   * @returns {Promise<string>} The _id field from `testCase()`
   */
  async assertWithoutId(points, message, testCase, expectedValue, assertion) {
    let _id;
    await assertion.call(
      this,
      points,
      message,
      async () => {
        const res = await testCase();
        if (res && typeof res === 'object') {
          _id = res._id;
          if (
            typeof _id !== 'string' ||
            _id.length !== 24 ||
            !/[a-f0-9]{24}/.test(_id)
          )
            throw "Invalid value provided for '_id'.";
          delete res._id;
        }
        return res;
      },
      expectedValue,
    );
    return _id;
  }

  /**
   * Asserts that a request response has a certain status code.
   * @param {number} points Points the test case is worth
   * @param {string} url URL to request
   * @param {Verb} method Request method to use
   * @param {*} body Request body (stringified automatically if needed)
   * @param {number} expectedStatus Status code that response should have
   * @returns {Promise<void>}
   */
  async assertRequestStatus(points, url, method, body, expectedStatus) {
    const [status] = await this.request(url, method, body);
    if (status === expectedStatus) return;
    this.deductPoints(
      points,
      `${method.toUpperCase()} ${url}` +
        (body ? `\n${JSON.stringify(body, null, 2)}` : ''),
      `Received status: ${status}\nExpected status: ${expectedStatus}`,
    );
  }

  /**
   * Asserts that a page has no HTML validation errors
   * @param {number} points Points to deduct for invalid HTML
   * @param {string} rawHTML Raw text of the page as a string
   * @param {string} pageName Name to print in comment
   */
  async assertValidHTML(points, rawHTML, pageName) {
    let res;
    try {
      // Manual timeout, because sometimes a 503 occurs if you send too many requests.
      await new Promise((resolve) => setTimeout(resolve, 100));
      res = await fetch('https://validator.nu/?out=json', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
        body: rawHTML,
      });
    } catch (e) {
      if (e instanceof TypeError)
        throw new Error("Couldn't contact the HTML validator successfully.");
      throw e;
    }
    if (res.status !== 200) {
      throw new Error(
        `"HTML Validator Error gave bad response: ${res.status} ${res.statusText}. Please re-run grader again later."`,
      );
    }
    const { messages } = await res.json();
    for (const message of messages) {
      if (message.type === 'error') {
        this.deductPoints(points, `${pageName} has HTML validation errors.`);
        break;
      }
    }
  }

  /**
   * Goes to a page with puppeteer with an interception handler.
   * Useful for posting data or any request that isn't a GET.
   * @param {Page} page Puppeteer page
   * @param {string} location Location to go to
   * @param {(req: HTTPRequest)=>any} handler Interception handler
   * @returns {Promise<HTTPResponse>}
   */
  async interceptRequest(page, location, handler) {
    await page.setRequestInterception(true);
    let error = false;
    page.once('request', async (req) => {
      try {
        await handler(req);
      } catch (e) {
        error = e;
      }
      await page.setRequestInterception(false);
    });
    const res = await page.goto(location);
    if (error)
      throw new Error(
        'Unable to load page. Possible server crash. Problematic page: ' +
          location,
      );
    return res;
  }

  /**
   * Builds a file URL from a relative file path for a file in a submission
   * @param {string} relativeFile Relative file path from submission root
   * @param {boolean} url Whether the returned path should be a URL
   * @param {boolean} oneTime Generate a fresh cache parameter for invalidation
   */
  buildAbsoluteFilePath(relativeFile, url, oneTime) {
    const absolutePath = path.resolve(path.join(this.directory, relativeFile));
    if (!url) return absolutePath;
    const href = pathToFileURL(absolutePath).href;
    return `${href}?invalidateCache=${oneTime ? uid() : this.uid}`;
  }

  /**
   * Import a JSON file from a relative location in the student submission.
   * @param {string} relativePath Relative file path from submission root
   * @returns {Promise<*>}
   */
  async importJSON(relativePath) {
    try {
      return JSON.parse(
        await fs.readFile(this.buildAbsoluteFilePath(relativePath, false), {
          encoding: 'utf8',
        }),
      );
    } catch (e) {
      if (e instanceof SyntaxError)
        throw `Malformed JSON syntax in '${relativePath}'`;
      throw e;
    }
  }

  /**
   * Import a javascript file from a relative location in the student submission.
   * @param {string} relativePath Relative file path from submission root
   * @param {boolean} [oneTime] Bypasses the cache and does a fresh import
   * @returns {Promise<*>}
   */
  async importFile(relativePath, oneTime) {
    const file = await import(
      this.buildAbsoluteFilePath(relativePath, true, oneTime)
    );
    return file.default ? file.default : file;
  }

  /**
   * Called internally by the grading framework.
   */
  async start() {
    const cmd = this.startScript.split(' ');
    if (!cmd[0] || cmd[0] !== 'node')
      throw new Error(
        'Possibly unsafe start script encountered: ' + this.startScript,
      );
    this.subprocess = await new Promise((resolve, reject) => {
      const subprocess = spawn(cmd[0], cmd.slice(1), {
        cwd: this.directory,
      });
      this.subprocessClosed = false;
      // Resolve eventually if we don't find what we want
      const timer = setTimeout(() => resolve(subprocess), 5000);
      // If URL printed, resolve immediately
      subprocess.stdout.on('data', (chunk) => {
        chunk = chunk.toString();
        if (chunk.includes('localhost') || chunk.includes('127.0.0.1')) {
          clearTimeout(timer);
          resolve(subprocess);
        }
      });
      // Track closure of subprocess
      subprocess.on('close', () => (this.subprocessClosed = true));
    });
  }

  /**
   * Called internally by the grading framework.
   */
  async checks() {
    const files = Object.fromEntries(
      this.requiredFiles.map((file) => [file, false]),
    );
    const entries = await fs.readdir(this.directory, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      const currentPath = entryPath(entry);
      if (
        !this.hadModules &&
        entry.isDirectory() &&
        entry.name == 'node_modules'
      ) {
        this.hadModules = true;
        this.deductPoints(5, 'Included node_modules in submission.');
        continue;
      }
      if (this.hadModules && currentPath.includes('node_modules')) continue;
      if (entry.name.toLowerCase() === 'package.json') {
        this.directory = currentPath;
        this.packageJson = await this.importJSON('package.json');
        continue;
      }
      if (files[entry.name] !== undefined) {
        files[entry.name] = true;
        if (!this.packageJson) this.directory = currentPath;
      }
    }
    this.directory = path.resolve(this.directory);
    if (this.checkPackage) {
      if (!this.packageJson) {
        this.deductPoints(5, 'Missing package.json file.');
        this.startScript = this.defaultStartScript;
      } else {
        if (!this.packageJson.type || this.packageJson.type !== 'module')
          this.module = false;
        if (this.packageJson.author) this.author = this.packageJson.author;
        if (!this.packageJson.scripts || !this.packageJson.scripts.start) {
          console.log(this.packageJson);
          this.deductPoints(5, 'Missing start script in package.json file.');
          this.startScript = this.defaultStartScript;
        } else {
          this.startScript = this.packageJson.scripts.start;
        }
      }
    }
    process.chdir(this.directory);
    const missingFiles = Object.entries(files)
      .filter(([_, found]) => !found)
      .map(([file, _]) => file)
      .join(', ');
    if (missingFiles) throw new Error('Missing file(s): ' + missingFiles);
    if (this.hasDatabase && this.requiredCollections.length) {
      const foundCollections = [];
      let collectionsFile;
      try {
        collectionsFile = await fs.readFile('./config/mongoCollections.js', {
          encoding: 'utf-8',
        });
      } catch {
        throw new Error("Couldn't read collections configuration.");
      }
      const matches = collectionsFile.matchAll(
        /^(?!.*(?:\/\/|\/\*)).*getCollectionFn\(['"`](.*?)['"`]\)/gm,
      );
      for (const [, collection] of matches) foundCollections.push(collection);
      const missingCollections = this.requiredCollections
        .filter((col) => !foundCollections.includes(col))
        .join(', ');
      const extraCollections = foundCollections
        .filter((col) => !this.requiredCollections.includes(col))
        .join(', ');
      if (missingCollections || extraCollections) {
        throw new Error(`Collections error: unexpected and/or missing collections.
- Missing collections: ${missingCollections || 'None'}
- Extra/unexpected collections: ${extraCollections || 'None'}`);
      }
    }
    this.assignmentConfig;
    if (this.packageJson && this.packageJson.dependencies)
      execSync('npm i', { cwd: this.directory });
  }

  /**
   * Sets up the grader for database access
   */
  async setupDatabase() {
    const settings = (await this.importFile('config/settings.js', true))
      .mongoConfig;
    settings.serverUrl = this.connectionString;
    this.database = settings.database;
    await fs.writeFile(
      this.buildAbsoluteFilePath('config/settings.js'),
      `export const mongoConfig = {
  serverUrl: "${settings.serverUrl}",
  database: "${settings.database}"
}
`,
    );
    this.client = await MongoClient.connect(this.connectionString);
    this.db = this.client.db(this.database);
  }

  /**
   * Override this with assignment-specific implementation.
   */
  async testCases() {
    throw new Error(
      'Please implement testCases() with appropriate test cases for the assignment.',
    );
  }

  /**
   * Called internally by the grading framework.
   */
  async run() {
    await this.checks();
    if (this.hasDatabase) await this.setupDatabase();
    if (this.runStartScript) await this.start();
    await this.testCases();
    await this.cleanup();
    return {
      grade: this.score,
      comments: this.comments.join('\n'),
    };
  }

  /**
   * Called internally by the grading framework.
   */
  async cleanup() {
    if (this.hasDatabase && this.db) {
      await this.db.dropDatabase();
      await this.client.close(true);
      try {
        const { closeConnection } = await this.importFile(
          'config/mongoConnection.js',
        );
        await closeConnection();
      } catch {}
    }
    if (this.subprocess && !this.subprocessClosed)
      if (!this.subprocess.kill())
        throw new FatalGraderError(
          'Failed to kill student submission process.',
        );
    if (!this.hadModules) {
      await fs.rm(path.join(this.directory, 'node_modules'), {
        recursive: true,
        force: true,
      });
    }
  }
}
