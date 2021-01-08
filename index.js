const hookcord = require('hookcord');
const Hook = new hookcord.Hook();
const Discord = require('discord.js');
const axios = require('axios').default;
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const id = process.env.WEBHOOK_ID;
const secret = process.env.WEBHOOK_SECRET;

const simpleParser = require('mailparser').simpleParser;
const urlPrefix = 'http://scf-email-pages.s3-website-us-east-1.amazonaws.com/'

function convertFlightInfoToDiscordEmbed(flightInfo) {
    return new Discord.MessageEmbed()
        .setColor('#1be1f2')
        .setTitle(flightInfo.subject)
        .setURL(urlPrefix + flightInfo.fileName)
        .setDescription(flightInfo.prices.join("\n"));
}


async function sendDiscordWebhookForFlights(flightInfo) {
    Hook.login(id, secret);

    const embed = convertFlightInfoToDiscordEmbed(flightInfo);

    Hook.setPayload(hookcord.DiscordJS(embed));

    await Hook.fire();
}

async function getGoogleFlightsLink(lines) {
    const flightsLinks = await Promise.all(lines.join('').match(/\bhttps?:\/\/\S+/gi)
        .map(url => {
            if (url.includes('>')) {
                return url.substr(0, url.indexOf('>'));
            }

            return url;
        })
        .map(getRedirectFromLink));

    return flightsLinks.filter(l => l.includes("www.google.com/flights"))[0];
}

async function getRedirectFromLink(link) {
    if (link.includes('www.google.com/flights')) {
        return link;
    }
    try {
        const resp = await axios.get(link, {
            maxRedirects: 0,
            validateStatus: false
        });

        return encodeURI(resp.headers.location);
    } catch (error) {
        console.error(error);
        return "";
    }
}


function parseUrlFromLine(line) {

}

async function uploadEmailHtml(email) {
    const mail = await simpleParser(email, {});
    const html = sanitizePrivateLinks(mail.html);
    const fileName = Date.now() + '.html'
    const params = {
        Body: html,
        Bucket: "scf-email-pages",
        Key: fileName,
        ContentType: 'text/html'
    };

    s3.putObject(params, function(err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else     console.log(data);           // successful response
    });

    return fileName;
}

async function parseCheapFlightsEmailToText(email) {
    const mail = await simpleParser(email, {});
    const subject = mail.subject.replace("Fwd: ", "");
    const body = await parseBody(mail.text);
    const fileName = await uploadEmailHtml(email);
    return {
        ...body,
        subject,
        fileName
    }
}

async function parseBody(body) {
    const lines = body.split("\n");
    const toAndPriceLines = lines.filter(line => line.includes("ATL") || line.includes("TO"));
    const pairedLines = toAndPriceLines.reduce(([pairs, last], val) => {
        const newPairs = [...pairs, `${last} ${val}`];
        return [newPairs, val];
    }, [[], toAndPriceLines[0]]);
    const atlPrices = pairedLines[0]
        .filter(l => l.includes("TO") && l.includes("ATL"))
        .filter(l => l.indexOf("TO") < l.indexOf("ATL"))
        .map(l => l.replace(/(\d)\*/, "$1 nonstop"))
        .map(l => l.replace(/\*/g, ""))
        .map(l => l.replace("Atlanta (ATL)", ""))
        .map(l => l.replace("TO: ", ""));

    const googleFlightsLink = await getGoogleFlightsLink(lines);

    return {
        prices: atlPrices,
        link: googleFlightsLink
    }
}

const getEmail = async (bucket, key) => {
    const params = {
        Bucket: bucket,
        Key: key
    };

    let data;
    try {
        data = await s3.getObject(params).promise();
    } catch (e) {
        console.log(e);
    }

    return data;
};

exports.handler = async (event) => {
    const key = event.Records[0].s3.object.key;
    const bucket = event.Records[0].s3.bucket.name;
    const email = await getEmail(bucket, key);
    const flightInfo = await parseCheapFlightsEmailToText(email.Body);
    await sendDiscordWebhookForFlights(flightInfo);
    return {
        statusCode: 200,
        body: JSON.stringify(event),
    };
};

const sanitizePrivateLinks = (html) => {
    const dom = new JSDOM(html);
    dom.window.document.getElementsByClassName('footer-container')[0].remove();
    return dom.window.document.documentElement.outerHTML;
}




