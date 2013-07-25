(function() {
  var SQLiteFactory, SQLitePlugin, SQLitePluginCallback, SQLitePluginTransaction, SQLiteTransactionCB, get_unique_id, pcb, root, trcbq, uid;
  root = this;
  SQLitePlugin = function(openargs, openSuccess, openError) {
    var dbname;
    console.log("SQLitePlugin");
    if (!(openargs && openargs['name'])) {
      throw new Error("Cannot create a SQLitePlugin instance without a db name");
    }
    dbname = openargs.name;
    this.openargs = openargs;
    this.dbname = dbname;
    this.openSuccess = openSuccess;
    this.openError = openError;
    this.openSuccess || (this.openSuccess = function() {
      return console.log("DB opened: " + dbname);
    });
    this.openError || (this.openError = function(e) {
      return console.log(e.message);
    });
    this.open(this.openSuccess, this.openError);
  };
  SQLitePlugin.prototype.databaseFeatures = {
    isSQLitePluginDatabase: true
  };
  SQLitePlugin.prototype.openDBs = {};
  SQLitePlugin.prototype.txQ = [];
  SQLitePlugin.prototype.transaction = function(fn, error, success) {
    var t;
    t = new SQLitePluginTransaction(this, fn, error, success);
    this.txQ.push(t);
    if (this.txQ.length === 1) {
      t.start();
    }
  };
  SQLitePlugin.prototype.startNextTransaction = function() {
    this.txQ.shift();
    if (this.txQ[0]) {
      this.txQ[0].start();
    }
  };
  SQLitePlugin.prototype.open = function(success, error) {
    if (!(this.dbname in this.openDBs)) {
      this.openDBs[this.dbname] = true;
      cordova.exec(success, error, "SQLitePlugin", "open", [this.openargs]);
    }
  };
  SQLitePlugin.prototype.close = function(success, error) {
    console.log("SQLitePlugin.prototype.close");
    if (this.dbname in this.openDBs) {
      delete this.openDBs[this.dbname];
      cordova.exec(null, null, "SQLitePlugin", "close", [this.dbname]);
    }
  };
  pcb = function() {
    return 1;
  };

  // XXX TBD fix callback(s):
  SQLitePlugin.prototype.executeSql = function(statement, params, success, error) {
    console.log("SQLitePlugin::executeSql[Statement]");
    pcb = success;
    cordova.exec((function() {
      return 1;
    }), error, "SQLitePlugin", "executePragmaStatement", [this.dbname, statement, params]);
  };
  // DEPRECATED AND WILL BE REMOVED:
  SQLitePlugin.prototype.executePragmaStatement = function(statement, success, error) {
    console.log("SQLitePlugin::executePragmaStatement");
    pcb = success;
    cordova.exec((function() {
      return 1;
    }), error, "SQLitePlugin", "executePragmaStatement", [this.dbname, statement]);
  };

  SQLitePluginCallback = {
    p1: function(id, result) {
      var mycb;
      console.log("PRAGMA CB");
      mycb = pcb;
      pcb = function() {
        return 1;
      };
      mycb(result);
    }
  };
  uid = 1000;
  get_unique_id = function() {
    return ++uid;
  };
  trcbq = {};
  SQLitePluginTransaction = function(db, fn, error, success) {
    this.trid = get_unique_id();
    trcbq[this.trid] = {};
    if (typeof fn !== "function") {
      throw new Error("transaction expected a function");
    }
    this.db = db;
    this.fn = fn;
    this.error = error;
    this.success = success;
    this.executes = [];
    this.executeSql("BEGIN", [], null, function(tx, err) {
      throw new Error("unable to begin transaction: " + err.message);
    });
  };
  SQLiteTransactionCB = {};
  SQLiteTransactionCB.queryCompleteCallback = function(transId, queryId, result) {
    var q, t;
    t = trcbq[transId];
    if (t) {
      q = t[queryId];
      if (q) {
        if (q["success"]) {
          q["success"](result);
        }
        delete trcbq[transId][queryId];
      }
    }
  };
  SQLiteTransactionCB.queryErrorCallback = function(transId, queryId, result) {
    var q, t;
    t = trcbq[transId];
    if (t) {
      q = t[queryId];
      if (q) {
        if (q["error"]) {
          q["error"](result);
        }
        delete trcbq[transId][queryId];
      }
    }
  };
  SQLiteTransactionCB.txCompleteCallback = function(transId) {};
  SQLiteTransactionCB.txErrorCallback = function(transId, error) {};
  SQLitePluginTransaction.prototype.start = function() {
    try {
      if (!this.fn) {
        return;
      }
      this.fn(this);
      this.fn = null;
      this.run();
    } catch (err) {
      this.db.startNextTransaction();
      if (this.error) {
        this.error(err);
      }
    }
  };
  SQLitePluginTransaction.prototype.executeSql = function(sql, values, success, error) {
    var qid;
    qid = get_unique_id();
    this.executes.push({
      success: success,
      error: error,
      qid: qid,
      sql: sql,
      params: values
    });
  };
  SQLitePluginTransaction.prototype.handleStatementSuccess = function(handler, response) {
    var payload, rows;
    if (!handler) {
      return;
    }
    rows = response.rows || [];
    payload = {
      rows: {
        item: function(i) {
          return rows[i];
        },
        length: rows.length
      },
      rowsAffected: response.rowsAffected || 0,
      insertId: response.insertId || void 0
    };
    handler(this, payload);
  };
  SQLitePluginTransaction.prototype.handleStatementFailure = function(handler, response) {
    if (!handler) {
      throw new Error("a statement with no error handler failed: " + response.message);
    }
    if (handler(this, response)) {
      throw new Error("a statement error callback did not return false");
    }
  };
  SQLitePluginTransaction.prototype.run = function() {
    var batchExecutes, handlerFor, i, qid, request, tropts, tx, txFailure, waiting;
    txFailure = null;
    tropts = [];
    batchExecutes = this.executes;
    waiting = batchExecutes.length;
    this.executes = [];
    tx = this;
    handlerFor = function(index, didSucceed) {
      return function(response) {
        try {
          if (didSucceed) {
            tx.handleStatementSuccess(batchExecutes[index].success, response);
          } else {
            tx.handleStatementFailure(batchExecutes[index].error, response);
          }
        } catch (err) {
          if (!txFailure) {
            txFailure = err;
          }
        }
        if (--waiting === 0) {
          if (txFailure) {
            return tx.rollBack(txFailure);
          } else if (tx.executes.length > 0) {
            return tx.run();
          } else {
            return tx.commit();
          }
        }
      };
    };
    i = 0;
    while (i < batchExecutes.length) {
      request = batchExecutes[i];
      qid = request.qid;
      trcbq[this.trid][qid] = {
        success: handlerFor(i, true),
        error: handlerFor(i, false)
      };
      tropts.push({
        trans_id: this.trid,
        query_id: qid,
        query: request.sql,
        params: request.params || []
      });
      i++;
    }
    cordova.exec(null, null, "SQLitePlugin", "executeSqlBatch", [this.db.dbname, tropts]);
  };
  SQLitePluginTransaction.prototype.rollBack = function(txFailure) {
    var failed, succeeded, tx;
    if (this.finalized) {
      return;
    }
    tx = this;
    succeeded = function() {
      delete trcbq[this.trid];
      tx.db.startNextTransaction();
      if (tx.error) {
        return tx.error(txFailure);
      }
    };
    failed = function(tx, err) {
      delete trcbq[this.trid];
      tx.db.startNextTransaction();
      if (tx.error) {
        return tx.error(new Error("error while trying to roll back: " + err.message));
      }
    };
    this.finalized = true;
    this.executeSql("ROLLBACK", [], succeeded, failed);
    this.run();
  };
  SQLitePluginTransaction.prototype.commit = function() {
    var failed, succeeded, tx;
    if (this.finalized) {
      return;
    }
    tx = this;
    succeeded = function() {
      delete trcbq[this.trid];
      tx.db.startNextTransaction();
      if (tx.success) {
        return tx.success();
      }
    };
    failed = function(tx, err) {
      delete trcbq[this.trid];
      tx.db.startNextTransaction();
      if (tx.error) {
        return tx.error(new Error("error while trying to commit: " + err.message));
      }
    };
    this.finalized = true;
    this.executeSql("COMMIT", [], succeeded, failed);
    this.run();
  };
  SQLiteFactory = {
    // NOTE: this function should NOT be translated from Javascript
    // back to CoffeeScript by js2coffee.
    // If this function is edited in Javascript then someone will
    // have to translate it back to CoffeeScript by hand.
    opendb: function() {
      var errorcb, first, okcb, openargs;
      if (arguments.length < 1) {
        return null;
      }
      first = arguments[0];
      openargs = null;
      okcb = null;
      errorcb = null;
      if (first.constructor === String) {
        openargs = {
          name: first
        };
        if (arguments.length >= 5) {
          okcb = arguments[4];
          if (arguments.length > 5) {
            errorcb = arguments[5];
          }
        }
      } else {
        openargs = first;
        if (arguments.length >= 2) {
          okcb = arguments[1];
          if (arguments.length > 2) {
            errorcb = arguments[2];
          }
        }
      }
      return new SQLitePlugin(openargs, okcb, errorcb);
    }
  };
  root.SQLitePluginCallback = SQLitePluginCallback;
  root.SQLiteQueryCB = SQLiteTransactionCB;
  return root.sqlitePlugin = {
    sqliteFeatures: {
      isSQLitePlugin: true
    },
    openDatabase: SQLiteFactory.opendb
  };
})();