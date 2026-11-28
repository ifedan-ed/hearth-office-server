/*
 * SPDX-FileCopyrightText: 2026 Hearth contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

'use strict';

// Hearth: a document converted ahead of its open ("prepare").
//
// When a person opens a document, the editor's socket asks the document
// service to open it, and the first open of each version of a file waits
// for the converter (x2t) to fetch the file from the WOPI host and turn
// it into the editor's own format (Editor.bin): 0.2 to 0.9 s on Hearth's
// server, more for big workbooks. The result is kept under the document's
// key (for an edit session the file's id) until the file's version
// changes, so a reopen of an unchanged file waits for nothing.
//
// POST /hearth/prepare does that first conversion before anyone opens the
// file: the host calls it when a file is uploaded or changed, and a later
// open finds the converted document as if someone had opened it before.
// It takes the same steps as the WOPI page and the editor's open, with
// upstream's own functions, so the task row it leaves is the one an open
// would have left:
//
//   1. CheckFileInfo with the host's token (the host's request is signed
//      with the inbox secret, as ConvertService's are);
//   2. the edit session's key (wopiClient.createDocId) and upstream's cache
//      check (checkAndInvalidateCache), which drops a converted copy of an
//      older version exactly as an open would;
//   3. nothing more when someone has the document open, a save is
//      pending, or a converted copy of this version is already kept;
//   4. otherwise the task row (commandOpenStartPromise, with the file's
//      information as its first callback, as preOpen writes it) and an
//      unlock marker after it, so the next open compares the file's
//      version with this one and converts again if the file changed in
//      between; then the open task on the converter's low-priority queue
//      (people's own opens go first) and a wait for its result.
//
// The token is used for CheckFileInfo and the converter's GetFile only;
// the marker carries mode "view", so nothing ever locks or unlocks the
// file with it. A conversion that fails leaves no row behind, so a
// person's open converts afresh and sees the engine's own error, if any.

const co = require('co');
const operationContext = require('./../../Common/sources/operationContext');
const commonDefines = require('./../../Common/sources/commondefines');
const constants = require('./../../Common/sources/constants');
const formatChecker = require('./../../Common/sources/formatchecker');
const taskResult = require('./taskresult');
const canvasService = require('./canvasservice');
const docsCoServer = require('./DocsCoServer');
const wopiClient = require('./wopiClient');
const utils = require('./../../Common/sources/utils');

// How long the request waits for the converter before answering
// "queued" (the conversion goes on; the host does not wait for it).
const WAIT_MS = 90 * 1000;
// How often the task row is read while waiting.
const POLL_MS = 100;

// openFormat is the editor's own format for a file type, or undefined for
// the kinds this does not prepare (PDF and drawings open through other
// paths).
function openFormat(fileType) {
  const format = formatChecker.getFormatFromString(fileType);
  if (formatChecker.isDocumentFormat(format)) {
    return constants.AVS_OFFICESTUDIO_FILE_CANVAS_WORD;
  }
  if (formatChecker.isSpreadsheetFormat(format)) {
    return constants.AVS_OFFICESTUDIO_FILE_CANVAS_SPREADSHEET;
  }
  if (formatChecker.isPresentationFormat(format)) {
    return constants.AVS_OFFICESTUDIO_FILE_CANVAS_PRESENTATION;
  }
  return undefined;
}

// prepare runs the steps above and says what happened: "prepared" (now
// converted), "kept" (already converted for this version), "busy" (open,
// or a save pending), "queued" (still converting when the wait ended),
// "skipped" (a kind that is not prepared), "failed".
function* prepare(ctx, wopiSrc, accessToken, accessTokenTtl, baseUrl) {
  const fileInfo = yield wopiClient.checkFileInfo(ctx, wopiSrc, accessToken);
  if (!fileInfo || fileInfo.error) {
    return {result: 'failed', status: fileInfo?.statusCode};
  }
  const fileType = wopiClient.getFileTypeByInfo(fileInfo);
  const outputFormat = openFormat(fileType);
  if (undefined === outputFormat || !(fileInfo.Size > 0)) {
    return {result: 'skipped'};
  }
  const docId = wopiClient.createDocId(ctx, wopiSrc, 'edit', fileInfo);
  ctx.setDocId(docId);
  const participants = yield docsCoServer.getParticipantMap(ctx, docId);
  if (participants.length > 0) {
    return {result: 'busy'};
  }
  // Drops a converted copy of another version (or keeps this one's lock
  // id: a row for this version is there, converted or converting).
  const check = yield wopiClient.checkAndInvalidateCache(ctx, docId, fileInfo);
  if (!check.success) {
    return {result: 'failed'};
  }
  if (undefined !== check.lockId) {
    const rows = yield taskResult.select(ctx, docId);
    const status = rows.length > 0 ? rows[0].status : undefined;
    return {result: commonDefines.FileStatus.Ok === status ? 'kept' : 'busy'};
  }

  const commonInfo = JSON.stringify({lockId: docId, fileInfo});
  const upsert = yield canvasService.commandOpenStartPromise(ctx, docId, baseUrl, commonInfo, fileType);
  if (!upsert.isInsert) {
    // An open made the row between the check and now: it converts.
    return {result: 'busy'};
  }
  // The WOPI parameters an open has (wopiClient.getWopiParams), in view
  // mode: nothing locks or unlocks with this token.
  const wopiParams = {
    commonInfo: {lockId: docId, fileInfo},
    userAuth: {wopiSrc, access_token: accessToken, access_token_ttl: accessTokenTtl, userSessionId: null, mode: 'view'},
    LastModifiedTime: fileInfo.LastModifiedTime || null
  };
  // The unlock marker: with it, the next open checks the file's version
  // against the one converted here (checkAndInvalidateCache).
  yield canvasService.commandOpenStartPromise(ctx, docId, undefined, wopiClient.getWopiUnlockMarker(wopiParams));

  // None to WaitQueue, as commandOpen does, so an open that arrives while
  // this converts waits for this conversion instead of starting its own.
  const updateMask = new taskResult.TaskResultData();
  updateMask.tenant = ctx.tenant;
  updateMask.key = docId;
  updateMask.status = commonDefines.FileStatus.None;
  const waiting = new taskResult.TaskResultData();
  waiting.status = commonDefines.FileStatus.WaitQueue;
  waiting.statusInfo = Math.floor(Date.now() / 60000);
  const updated = yield taskResult.updateIf(ctx, waiting, updateMask);
  if (!(updated.affectedRows > 0)) {
    return {result: 'busy'};
  }

  const cmd = new commonDefines.InputCommand();
  cmd.setCommand('open');
  cmd.setDocId(docId);
  // The address is built from the WOPI parameters (wopiUtils.getWopiFileUrl);
  // the converter only needs one to be set, as convertAndEdit does.
  cmd.setUrl('dummy-url');
  cmd.setWopiParams(wopiParams);
  cmd.setFormat(fileType);
  cmd.setTitle(fileInfo.BaseFileName);
  cmd.setOutputFormat(outputFormat);
  cmd.setNoBase64(true);
  cmd.setEmbeddedFonts(false);
  const task = new commonDefines.TaskQueueData();
  task.setCtx(ctx);
  task.setCmd(cmd);
  task.setToFile('Editor.bin');
  yield* docsCoServer.addTask(task, constants.QUEUE_PRIORITY_LOW);

  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    yield new Promise(resolve => setTimeout(resolve, POLL_MS));
    const rows = yield taskResult.select(ctx, docId);
    const status = rows.length > 0 ? rows[0].status : undefined;
    if (commonDefines.FileStatus.Ok === status || commonDefines.FileStatus.NeedPassword === status) {
      return {result: 'prepared'};
    }
    if (commonDefines.FileStatus.WaitQueue !== status) {
      // Failed: leave nothing, so a person's open converts afresh. Only
      // while nobody has joined it.
      const now = yield docsCoServer.getParticipantMap(ctx, docId);
      if (0 === now.length && undefined !== status) {
        yield canvasService.cleanupCache(ctx, docId);
      }
      return {result: 'failed', status};
    }
  }
  return {result: 'queued'};
}

// prepareHandler is POST /hearth/prepare. The body is a JSON object, or a
// JWT of one signed with the inbox secret ({"token": ...} or the
// Authorization header, as ConvertService takes it): wopisrc,
// access_token and access_token_ttl. The answer is {result, ms}.
function prepareHandler(req, res) {
  return co(function* () {
    const ctx = new operationContext.Context();
    const started = Date.now();
    let out = {result: 'failed'};
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      const auth = yield docsCoServer.getRequestParams(ctx, req);
      if (auth.code !== constants.NO_ERROR) {
        ctx.logger.warn('hearth prepare: refused %j', auth);
        res.status(403).json({result: 'refused'});
        return;
      }
      const params = auth.params;
      const wopiSrc = params.wopisrc;
      if ('string' !== typeof wopiSrc || !params.access_token) {
        res.status(400).json({result: 'bad request'});
        return;
      }
      ctx.setDocId(wopiSrc.substring(wopiSrc.lastIndexOf('/') + 1));
      out = yield* prepare(ctx, wopiSrc, String(params.access_token), parseInt(params.access_token_ttl) || 0, utils.getBaseUrlByRequest(ctx, req));
    } catch (err) {
      ctx.logger.error('hearth prepare error:', err);
    }
    out.ms = Date.now() - started;
    ctx.logger.info('hearth prepare %j', out);
    res.json(out);
  });
}

exports.prepareHandler = prepareHandler;
exports.openFormat = openFormat;
