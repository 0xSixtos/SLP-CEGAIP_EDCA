'use strict';

var assert = require('assert');
var http = require('http');
var path = require('path');
var Module = require('module');
var express = require('express');
var shouldFail = false;
var databaseError = new Error('Simulated database failure');
var database = {
    task: function () {
        return shouldFail ? Promise.reject(databaseError) : Promise.resolve([
            {total: '2'}, {total: '3'}, {total: '4'}, {total: '500'}
        ]);
    }
};

// Isolate external services: no PostgreSQL connection or PDF process is created.
var originalLoad = Module._load;
var router;
try {
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === path.resolve(__dirname, '../routes/index.js')) {
            if (request === '../dash_config') return {dashboard: database};
            if (request === 'pg-promise') return function () { return function () {}; };
            if (request === 'html-pdf') return {};
        }
        return originalLoad.apply(this, arguments);
    };
    router = require('../routes/index');
} finally {
    Module._load = originalLoad;
}

var app = express();
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'ejs');
app.use(function (req, res, next) {
    var render = res.render;
    res.render = function (view, values) {
        if (view === 'index') return res.json(values.metadata);
        return render.apply(this, arguments);
    };
    next();
});
app.use('/contratacionesabiertas', router);
app.use(function (error, req, res, next) {
    res.status(error.status || 500).render('error', {message: error.message, error: {}});
});

var server = app.listen(0, '127.0.0.1', function () {
    request(false).then(function (response) {
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(JSON.parse(response.body), {
            supplier_count: '2', cp_count: '3', contract_count: '4',
            contract_exchangerate_amount_total: '500'
        });
        return request(true);
    }).then(function (response) {
        assert.strictEqual(response.status, 500);
        assert.ok(response.body.indexOf('No se ha podido cargar la pagina') !== -1);
        assert.ok(response.body.indexOf(databaseError.message) === -1);
        console.log('PASS: home metadata and completed generic HTTP 500 on database failure');
        server.close();
    }).catch(function (error) {
        console.error(error);
        process.exitCode = 1;
        server.close();
    });
});

function request(fail) {
    shouldFail = fail;
    return new Promise(function (resolve, reject) {
        var req = http.get({hostname: '127.0.0.1', port: server.address().port,
            path: '/contratacionesabiertas/'}, function (res) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { body += chunk; });
            res.on('end', function () { resolve({status: res.statusCode, body: body}); });
        });
        req.setTimeout(1000, function () {
            req.abort();
            reject(new Error('Home request timed out instead of returning an HTTP response'));
        });
        req.on('error', reject);
    });
}
