const _ = require('lodash');
const debug = require('debug')('lib:parserchain');
const nconf = require('nconf'); 
const JSDOM = require('jsdom').JSDOM;

const mongo3 = require('./mongo3');

module.exports = {
    /* this sequence is executed in this order.
     * after the newline there are modules that levegared on previously mined metadata */
    dissectorList: [
        'nature',
        'imageChains',
        'event',
    ],

    event: require('../parsers/event'),
    nature: require('../parsers/nature'),
    imageChains: require('../parsers/imageChains'),

    // functions
    initializeMongo,
    getLastHTMLs,
    wrapDissector,
    updateMetadataAndMarkHTML,
    buildMetadata,
};

function buildMetadata(entry) {
    // this contains the original .source (html, impression, timeline), the .findings and .failures 
    let metadata = _.omit(entry.source.html, ['_id', 'clientTime', 'processed' ]);
    metadata.savingTime = new Date(entry.source.html.savingTime);
    metadata.when = new Date();
    return _.merge(metadata, _.get(entry, 'findings', {}));
}

const mongodrivers = {
    readc: null,
    writec: null,
};

async function initializeMongo(amount) {
    mongodrivers.readc = await mongo3.clientConnect({concurrency: 1});
    mongodrivers.writec = await mongo3.clientConnect({concurrency: amount});
}

async function getLastHTMLs(filter, amount) {

    if(!mongodrivers.readc)
        await initializeMongo(amount);

    const htmls = await mongo3.aggregate(mongodrivers.readc,
        nconf.get('schema').htmls, [ 
            { $match: filter },
            { $sort: { "savingTime": 1 } },
            { $limit: amount },
            { $lookup: { from: 'supporters', localField: 'publicKey', foreignField: 'publicKey', as: 'supporter'} },
        ]);

    let errors = 0;
    const formatted = _.map(htmls, function(h) {
        try {
            const envelope = {
                html: _.omit(h, ['html', 'supporter']),
                supporter: _.first(h.supporter),
                jsdom: new JSDOM(h.html.replace(/\n\ +/g, '')).window.document,
            } ;
            return envelope;
        }
        catch(error) {
            errors++;
            debug("Error when formatting HTML: %s, htmlId %s", error.message, h.id);
        }
    });

    return {
        overflow: _.size(htmls) == amount,
        sources: _.compact(formatted),
        errors,
    }
}

async function wrapDissector(dissectorF, dissectorName, source, envelope) {
    try {
        // this function pointer point to all the functions in parsers/*
        // as argument they take function(source ({.jsdom, .html}, previous {...}))
        let retval = await dissectorF(source, envelope.findings);
        let resultIndicator = JSON.stringify(retval).length;
        if(typeof retval === 'boolean')
            resultIndicator = retval;
        _.set(envelope.log, dissectorName, resultIndicator);
        return retval;
    } catch(error) {
        debug("Error in %s: %s", dissectorName, error.message)
        debug("%s", error.stack);
        _.set(envelope.log, dissectorName, "!E");
        throw error;
    }
}

async function updateMetadataAndMarkHTML(e) {
    let r = await mongo3.upsertOne(mongodrivers.writec, nconf.get('schema').metadata, { id: e.id }, e);
    let u = await mongo3.updateOne(mongodrivers.writec, nconf.get('schema').htmls, { id: e.id }, { processed: true });
    return [ r.result.ok, u.result.ok ];
}