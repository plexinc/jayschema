//
// JaySchema (draft v4) validator for Node.js.
//

'use strict';

var Errors = require('./errors.js')
  , crypto = require('crypto')
  , SchemaRegistry = require('./schemaRegistry.js')
  , when = require('when')
  , keys = require('when/keys')
  ;


var DEFAULT_SCHEMA_VERSION = 'http://json-schema.org/draft-04/schema#';
var ANON_URI_SCHEME = 'anon-schema';

var testRunners = {
  'http://json-schema.org/draft-04/schema#': require('./suites/draft-04'),
  'http://json-schema.org/schema#': require('./suites/draft-04')
};

// ******************************************************************
// Constructor
// ******************************************************************
var JaySchema = function(loader) {
  // public
  this.maxRecursion = 5;
  this.loader = (typeof loader === 'function') ? loader : null;

  // internal
  this._schemaRegistry = new SchemaRegistry();
  this._customFormatHandlers = {};

  // _refsRequested is an object where the key is the normalized ID
  // of the schema ref that was requested, and the value is a
  // promise for the content of that schema.
  this._refsRequested = {};
};

// ******************************************************************
// [static] Pre-defined schema loaders (can be passed to the
// constructor)
// ******************************************************************
JaySchema.loaders = {
  http: require('./httpLoader.js')
};

// ******************************************************************
// [static] Export the errors classes so they can be used by schema
// loaders and others.
// ******************************************************************
JaySchema.errors = Errors;

// ******************************************************************
// Get an array of $refs for which we don’t have a schema yet.
// ******************************************************************
JaySchema.prototype.getMissingSchemas = function() {
  return this._schemaRegistry.getMissingSchemas();
};

// ******************************************************************
// Return boolean indicating whether the specified schema id has
// previously been registered.
// ******************************************************************
JaySchema.prototype.isRegistered = function(id) {
  return this._schemaRegistry.isRegistered(id);
};

// ******************************************************************
// Register a schema.
// ******************************************************************
JaySchema.prototype.register = function() {
  return this._schemaRegistry.register.apply(this._schemaRegistry, arguments);
};

// ******************************************************************
// Register a handler for the format keyword. Handlers have the
// following signature:
//
//  function handler(value) -> returns null (if value is valid) or
//                             error description string (if value is
//                             not valid)
// ******************************************************************
JaySchema.prototype.addFormat = function(attributeName, handler) {
  // Wrap the format handler to make its signature match that of the
  // internal handlers.
  var handlerWrapper = function(config) {
    var errors = [];
    var result = handler(config.inst, config.schema);
    if (typeof result === 'string') {
      errors.push(new Errors.FormatValidationError(config.resolutionScope,
        config.instanceContext, 'format', attributeName, config.inst, result));
    } else if (result !== null) {
      var desc = 'failed custom format validation';
      errors.push(new Errors.FormatValidationError(config.resolutionScope,
        config.instanceContext, 'format', attributeName, config.inst, desc));
    }
    return errors;
  };
  this._customFormatHandlers[attributeName] = handlerWrapper;
};

// ******************************************************************
// [static] Return a hash for an object. We rely on JSON.stringify
// to always return the same value for a given object. (If it
// doesn’t return the same value, the parser will be somewhat slower
// and use more memory. It does seem to always return the same
// value based on observation and on Ecma-262 5.1 § 15.12.3.)
// ******************************************************************
JaySchema._getObjectHash = function(obj) {
  var shasum = crypto.createHash('sha1');
  shasum.update(JSON.stringify(obj));
  return shasum.digest('hex');
};

// ******************************************************************
// Helper to call the user-provided schema loader.
// ******************************************************************
JaySchema.prototype._loadMissingRefs = function(depth, callback) {
  var err;

  // try not to request the same ref more than once
  var schemasNeeded = this._schemaRegistry.getMissingSchemas();

  // get a list of missing refs that have not been requested yet
  var missing = schemasNeeded.filter(function(ref) {
    var registered = this._schemaRegistry.isRegistered(ref);
    var requested = (SchemaRegistry._normalizeId(ref) in this._refsRequested);
    return (!registered && !requested);
  }, this);

  // are we in too deep?
  if (missing.length && !depth) {
    var desc = 'would exceed max recursion depth fetching these referenced ' +
      'schemas (set the maxRecursion property if you need to go deeper): ' +
      missing;
    err = new Errors.ValidationError(undefined, undefined, undefined,
      undefined, undefined, desc);
    return callback(err);
  }

  // function called when the loader finishes loading a schema
  var onLoaded = function(ref, deferred, loaderErr, schema) {
    if (loaderErr) { return deferred.reject(loaderErr); }
    if (!this._schemaRegistry.isRegistered(ref)) { this.register(schema, ref); }
    deferred.resolve(schema);
  };

  // now request the missing refs that have not been requested yet
  for (var index = 0, len = missing.length; index !== len; ++index) {
    var ref = missing[index];
    var deferred = when.defer();
    this._refsRequested[SchemaRegistry._normalizeId(ref)] = deferred.promise;
    this.loader(ref, onLoaded.bind(this, ref, deferred));
  }

  // wait for all of them
  var self = this;
  keys.all(this._refsRequested).then(
    function() {
      // all promises fulfilled

      if (missing.length) {
        // We loaded some schemas. We need to recurse to load
        // additional schemas that were referenced by the schemas we
        // just loaded.
        self._loadMissingRefs(depth - 1, callback);
      } else {
        // We didn’t load any more schemas ourselves; we were just
        // waiting for any loader promises to be fulfilled.
        callback();
      }
    },
    callback  // one or more promises rejected
  );
};

// ******************************************************************
// The main validation guts (internal implementation).
// ******************************************************************
JaySchema.prototype._validateImpl = function(instance, schema, resolutionScope,
  instanceContext)
{
  // for schemas that have no id, use an internal anonymous id
  var schemaId = schema.id || resolutionScope ||
    ANON_URI_SCHEME + '://' + JaySchema._getObjectHash(schema) + '/#';

  if (!this._schemaRegistry.isRegistered(schemaId)) {
    this.register(schema, schemaId, resolutionScope);
  }
  resolutionScope = resolutionScope || schemaId;
  if (resolutionScope.indexOf('#') === -1) { resolutionScope += '#'; }

  // no schema passed
  if (!schema) { return [];}

  // run the tests
  var config = {
    clone: function() {
      var result = {};
      var keys = Object.keys(this);
      for (var index = 0, len = keys.length; index !== len; ++index) {
        result[keys[index]] = this[keys[index]];
      }
      return result;
    },
    inst: instance,
    schema: schema,
    resolutionScope: resolutionScope,
    instanceContext: instanceContext || '#',
    schemaRegistry: this._schemaRegistry,
    customFormatHandlers: this._customFormatHandlers
  };

  var testRunner = testRunners[schema.$schema || DEFAULT_SCHEMA_VERSION];

  if (!testRunner) {
    var desc = 'The top-level schema (' + schema.$schema + ') is not ' +
      'supported by this validator. Supported schemas are: ' +
      Object.keys(testRunners).join(', ');
    var err = new Errors.ValidationError(undefined, undefined, undefined,
      undefined, undefined, desc);
    return [err];
  }

  return testRunner(config);
};

// ******************************************************************
// The main validation function (public API). Our raison d'être.
// ******************************************************************
JaySchema.prototype.validate = function(instance, schema, callback)
{
  var desc, err;

  if (typeof schema === 'string') {
    schema = this._schemaRegistry.get(schema) || { $ref: schema };
  }

  if (!schema) {
    desc = 'No schema provided for validation.';
    err = new Errors.ValidationError(undefined, '#', undefined, undefined,
      undefined, desc);
    if (callback) {
      return process.nextTick(callback.bind(null, [err]));
    } else {
      return [err];
    }
  }

  // for schemas that have no id, use an internal anonymous id
  schema.id = schema.id || JaySchema._getObjectHash(schema);
  var schemaId = schema.id || ANON_URI_SCHEME + '://' +
    JaySchema._getObjectHash(schema) + '/#';
  this.register(schema, schemaId);

  if (callback) {

    var self = this;
    var result;

    if (self.loader) {

      // If the user provided a loader callback, load all unresolved
      // $references schemas at this time.
      self._loadMissingRefs(self.maxRecursion, function(err) {
        if (err) { return callback([err]); }
        result = self._validateImpl(instance, schema);
        if (result.length) { process.nextTick(callback.bind(null, result)); }
        else { process.nextTick(callback); }
      });

    } else {
      // no loader, but user still wants a callback
      result = this._validateImpl(instance, schema);
      if (result.length) { process.nextTick(callback.bind(null, result)); }
      else { process.nextTick(callback); }
    }

  } else {

    // traditional, non-callback validation
    var errs = [];

    if (this.loader) {
      desc = 'You provided a loader callback, but you are calling ' +
        'validate() synchronously. Your loader will be ignored and ' +
        'validation will fail if any missing $refs are encountered.';
      err = new Errors.LoaderAsyncError(undefined, undefined, undefined,
        undefined, undefined, desc);
      errs.push(err);
    }

    errs = errs.concat(this._validateImpl(instance, schema));
    return errs;
  }
};

module.exports = JaySchema;
