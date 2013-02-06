//
// JaySchema (draft v4) validator for Node.js.
//

'use strict';

var jsonPointer = require('./jsonPointer.js')
  , url = require('url')
  , downloadSchema = require('./downloadSchema.js')
  , Errors = require('./errors.js')
  , uuid = require('./uuid.js')
  ;


var DEFAULT_SCHEMA_VERSION = 'http://json-schema.org/draft-04/schema#';
var ANON_URI_SCHEME = 'anon-schema';

var schemaTestSets = {
  'http://json-schema.org/draft-04/schema#': require('./suites/draft-04.js')
};

// ******************************************************************
// Constructor
// ******************************************************************
var JaySchema = function(maxPreload) {
  this.schemas = {};
  this._urlsRequested = [];
  this.maxPreload = maxPreload || 5;
};

// ******************************************************************
// Register the given schema in our library of schemas.
// ******************************************************************
JaySchema.prototype.register = function(schema, resolutionScope, _fallbackId,
  _path)
{
  // We stash each schema that has a unique URI, not including
  // the fragment part.

  var id = schema.id || _fallbackId;
  if (id) {
    var resolvedId = jsonPointer.resolve(resolutionScope, id);
    resolutionScope = resolvedId;
    var parts = url.parse(resolvedId);
    var fragment = parts.hash;
    delete parts.hash;
    var baseUri = url.format(parts);

    if (!fragment || fragment === '#' || fragment === '') {
      // top-level schema
      if (this.schemas.hasOwnProperty(baseUri)) {
        // this and its sub-schemas are already registered
        return;
      }
      this.schemas[baseUri] = { schema: schema, fragments: {} };
      _path = '#';
    } else {
      // fragment reference within a top-level schema
      if (this.schemas.hasOwnProperty(baseUri)) {
        if (!this.schemas[baseUri].fragments.hasOwnProperty(fragment)) {
          this.schemas[baseUri].fragments[fragment] = _path;
        }
      }
    }
  }

  // register sub-schemas
  var keys = Object.keys(schema);
  for (var index = 0, len = keys.length; index !== len; ++index) {
    var key = keys[index];
    if (typeof schema[key] === 'object') {
      if (!Array.isArray(schema[key])) {
        this.register(schema[key], resolutionScope, null, _path + '/' + key);
      }
    }
  }
};

// ******************************************************************
// Get a previously-registered schema, if available. Returns null if
// the schema is not available.
// ******************************************************************
JaySchema.prototype.getSchema = function(resolvedId) {
  var parts = url.parse(resolvedId);
  var fragment = parts.hash;
  delete parts.hash;
  var baseUri = url.format(parts);

  if (!this.schemas.hasOwnProperty(baseUri)) { return null; }

  if (!fragment || fragment === '#' || fragment === '') {

    // base, non-fragment URI
    return this.schemas[baseUri].schema;
  } else {

    // It’s a fragment, and can be either a JSON pointer or a URI
    // fragment identifier. In the latter case, look up the
    // corresponding JSON pointer and proceed.

    if (fragment.slice(0, 2) !== '#/') {  // URI fragment
      fragment = this.schemas[baseUri].fragments[fragment] || fragment;
    }

    var path = fragment.slice(2).split('/');
    var currentSchema = this.schemas[baseUri].schema;
    while (path.length) {
      var element = jsonPointer.decode(path.shift());
      if (!currentSchema.hasOwnProperty(element)) { return null; }
      currentSchema = currentSchema[element];
    }
    return currentSchema;
  }
};

// ******************************************************************
// [static] Helper to gather all $refs values from the given object
// ******************************************************************
JaySchema._gatherRefs = function(obj) {
  var result = [];
  var keys = Object.keys(obj);
  if (obj.$ref) { result.push(obj.$ref); }
  for (var index = 0, len = keys.length; index !== len; ++index) {
    var key = keys[index];
    if (typeof obj[key] === 'object') {
      result = result.concat(JaySchema._gatherRefs(obj[key]));
    }
  }
  return result;
};

// ******************************************************************
// Recursively and asynchronously pre-load all schemas that are
// referenced ('$ref') from the given schema.
//
// Recurses to the given depth: if a schema references an external
// schema, it will be fetched. If THAT schema references an external
// schema, it will be fetched etc. Once this reaches the specified
// depth, an error will be returned.
// ******************************************************************
JaySchema.prototype._recursivePreload = function(schema, depth, callback) {
  var self = this;
  var errs = [];
  var index, len, ref;

  var refs = JaySchema._gatherRefs(schema);

  refs = refs.filter(function(ref) {
    if (this.schemas.hasOwnProperty(ref)) { return false; }
    if (this._urlsRequested.indexOf(ref) !== -1) { return false; }
    var parts = url.parse(ref);
    if (!parts.protocol || parts.protocol.slice(0, 4) !== 'http') {
      return false;
    }
    return true;
  }, this);

  // nothing to fetch?
  if (refs.length === 0) { return process.nextTick(callback); }

  // are we in too deep?
  if (!depth) {
    var desc = 'would exceed max recursion depth fetching these referenced ' +
      'schemas: ' + refs;
    var err = new Errors.ValidationError(null, null, null, null, null,
      desc);
    return process.nextTick(callback.bind(null, err));
  }

  // fetch 'em
  var completedCount = 0;
  var totalCount = refs.length;

  for (index = 0, len = refs.length; index !== len; ++index) {
    ref = refs[index];
    this._urlsRequested.push(ref);
    downloadSchema(ref, function(err, schema) {
      if (err) { return errs.push(err); }
      self.register(schema, ref, ref);
      self._recursivePreload(schema, depth - 1, function(moreErrs) {
        if (moreErrs) { errs = errs.concat(moreErrs); }
        completedCount++;
        if (completedCount === totalCount) {
          callback(errs);
        }
      });
    });
  }
};

// ******************************************************************
// The main validation guts (internal implementation).
// ******************************************************************
JaySchema.prototype._validateImpl = function(instance, schema, resolutionScope,
  instanceContext)
{
  // for schemas that have no id, use an internal anonymous id
  var schemaId = schema.id || ANON_URI_SCHEME + '://' + uuid.uuid4() + '#';
  this.register(schema, resolutionScope, schemaId);
  resolutionScope = resolutionScope || schemaId;

  // dereference schema if needed
  if (schema.hasOwnProperty('$ref')) {
    var ref = jsonPointer.resolve(resolutionScope, decodeURI(schema.$ref));
    resolutionScope = ref;
    schema = this.getSchema(ref);

    if (!schema) {
      var desc = 'schema not available: ' + ref;
      if (ref.slice(0, 4) === 'http') {
        desc += ' [schemas can be retrieved over HTTP, but only if ' +
          'validate() is called asynchronously]';
      }
      var err = new Errors.ValidationError(null, null, null, null, null,
        desc);
      return [err];
    }
  }

  // no schema passed
  if (!schema) { return [];}

  // create the TestSet for this schema version
  var TestSetClass = schemaTestSets[schema.$schema || DEFAULT_SCHEMA_VERSION];
  var testSet = new TestSetClass(this._validateImpl.bind(this), instance,
    schema, resolutionScope, instanceContext || '#');

  return testSet.run();
};

// ******************************************************************
// The main validation function (public API). Our raison d'être.
// ******************************************************************
JaySchema.prototype.validate = function(instance, schema, callback)
{
  // for schemas that have no id, use an internal anonymous id
  var schemaId = schema.id || ANON_URI_SCHEME + '://' + uuid.uuid4() + '#';
  this.register(schema, null, schemaId);

  // preload referenced schemas (recursively)
  if (callback) {
    var self = this;
    self._recursivePreload(schema, this.maxPreload, function(errs) {
      // no further disk or net I/O from here on
      if (errs && errs.length !== 0) { return callback(errs); }
      var result = self._validateImpl(instance, schema);
      if (result.length) { callback(result); }
      else { callback(); }
    });
  } else {
    return this._validateImpl(instance, schema);
  }
};

module.exports = JaySchema;