import React from '/node_modules/react';

///////////
// About page copy
const aboutHeading = `\
HashHype summarizes internet noise
`;

const aboutBody = `\
Cut through the chatter. Be the first to react.
`;

const aboutTech = (gNavView) => {
    return (
        <>HashHype uses a natural language algorithm to determine what people are talking about, then selects a single user comment to represent each trending topic.
        The top trends are presented in real-time. By setting alerts, or custom actions, users can <a onClick={gNavView.showSetTrendActionModal.bind(gNavView)}>react to trends</a> as they unfold.</>
    );
}

/////////////
// Disclaimer page copy
const disclaimerBody = `\
All data and information is provided “as is” for informational purposes only, and is not intended for trading purposes or financial, investment, tax, legal, accounting or other advice. Please consult your broker or financial representative to verify pricing before executing any trade.  HashHype is not an investment adviser, financial adviser or a securities broker.  None of the data and information constitutes investment advice nor an offering, recommendation or solicitation by HashHype to buy, sell or hold any security or financial product, and HashHype makes no representation (and has no opinion) regarding the advisability or suitability of any investment.

None of the data and information constitutes investment advice (whether general or customized). The financial products or operations referred to in such data and information may not be suitable for your investment profile and investment objectives or expectations. It is your responsibility to consider whether any financial product or operation is suitable for you based on your interests, investment objectives, investment horizon and risk appetite. HashHype shall not be liable for any damages arising from any operations or investments in financial products referred to within. HashHype does not recommend using the data and information provided as the only basis for making any investment decision.

Data is provided by financial exchanges and other content providers and may be delayed as specified by financial exchanges or other data providers. HashHype does not verify any data and disclaims any obligation to do so.

HashHype, its data or content providers, the financial exchanges and each of their affiliates and business partners (A) expressly disclaim the accuracy, adequacy, or completeness of any data and (B) shall not be liable for any errors, omissions or other defects in, delays or interruptions in such data, or for any actions taken in reliance thereon. Neither HashHype nor any of our information providers will be liable for any damages relating to your use of the information provided herein. As used here, “business partners” does not refer to an agency, partnership, or joint venture relationship between HashHype and any such parties.

You agree not to copy, modify, reformat, download, store, reproduce, reprocess, transmit or redistribute any data or information found herein or use any such data or information in a commercial enterprise without obtaining prior written consent.

Either HashHype or its third party data or content providers have exclusive proprietary rights in the data and information provided.

HashHype displays content from third parties. Displayed content may originate from sources which are not affiliated with HashHype. Displayed content does not necessarily represent the views of HashHype or its affiliates. Displayed content is not censored for all audiences.
`;

export default {
    aboutHeading: aboutHeading,
    aboutBody: aboutBody,
    aboutTech: aboutTech,

    disclaimerBody: disclaimerBody
};
