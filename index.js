const hookcord = require('hookcord');
const Hook = new hookcord.Hook();
const Discord = require('discord.js');
const axios = require('axios').default;
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const id = process.env.WEBHOOK_ID;
const secret = process.env.WEBHOOK_SECRET;

const simpleParser = require('mailparser').simpleParser;


function convertFlightInfoToDiscordEmbed(flightInfo) {
    return new Discord.MessageEmbed()
        .setColor('#1be1f2')
        .setTitle(flightInfo.subject)
        .setURL(flightInfo.link)
        .setDescription(flightInfo.prices.join("\n"));
}


async function sendDiscordWebhookForFlights(flightInfo) {
    Hook.login(id, secret);

    const embed = convertFlightInfoToDiscordEmbed(flightInfo);

    Hook.setPayload(hookcord.DiscordJS(embed));

    await Hook.fire();
}

async function getGoogleFlightsLink(lines){
    const flightsLinks = await Promise.all(lines.join('').match(/\bhttps?:\/\/\S+/gi)
        .map(url => {
            if(url.includes('>')){
                return url.substr(0, url.indexOf('>'));
            }

            return url;
        })
        .map(getRedirectFromLink));

    return flightsLinks.filter(l => l.includes("www.google.com/flights"))[0];
}

async function getRedirectFromLink(link) {
    if(link.includes('www.google.com/flights')){
        return link;
    }
    try{
        const resp = await axios.get(link, {
            maxRedirects: 0,
            validateStatus: false
        });

        return encodeURI(resp.headers.location);
    } catch(error){
        console.error(error);
        return "";
    }
}


function parseUrlFromLine(line) {

}

async function parseCheapFlightsEmailToText(email) {
    const mail = await simpleParser(email, {});
    const subject = mail.subject.replace("Fwd: ", "");
    const body = await parseBody(mail.text);
    return {
        ...body,
        subject
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

const test = {
    "Records": [
        {
            "eventVersion": "2.1",
            "eventSource": "aws:s3",
            "awsRegion": "us-east-1",
            "eventTime": "2019-09-28T15:48:04.352Z",
            "eventName": "ObjectCreated:Put",
            "userIdentity": {
                "principalId": "AWS:AIDAIE26RTG3F45XIHQFI"
            },
            "requestParameters": {
                "sourceIPAddress": "10.88.185.132"
            },
            "responseElements": {
                "x-amz-request-id": "50EA33958447F3FA",
                "x-amz-id-2": "DLbyxBIPPGlFwbe0terpTQwrrVxWB4OT00wQxvW95GWaLnDAGzAaJJJk2Puo8UK+mbQYgx+IOD4="
            },
            "s3": {
                "s3SchemaVersion": "1.0",
                "configurationId": "d829fa27-35c7-48c5-aba5-c73a253836e8",
                "bucket": {
                    "name": "parlicious-emails-scf",
                    "ownerIdentity": {
                        "principalId": "AX1W6INXTNCXR"
                    },
                    "arn": "arn:aws:s3:::parlicious-emails-scf"
                },
                "object": {
                    "key": "1iq2rgnrfura12vgr60ssa7ot04k9ulsccuat401",
                    "size": 76125,
                    "eTag": "cc97626a97e080f6ba60cc9997615716",
                    "sequencer": "005D8F80B4497B898A"
                }
            }
        }
    ]
};

exports.handler = async (event) => {
    console.log('starting');
    const key = event.Records[0].s3.object.key;
    const bucket = event.Records[0].s3.bucket.name;
    const email = await getEmail(bucket, key);
    const flightInfo = await parseCheapFlightsEmailToText(email.Body);
    console.log(flightInfo);
    await sendDiscordWebhookForFlights(flightInfo);

    const response = {
        statusCode: 200,
        body: JSON.stringify(event),
    };
    return response;
};




// exports.handler(test).then().catch(console.error);

