const config = require('../config');
const axios = require('axios');

//TODO: check if this code can be moved in the nginx config

const pdfGeneratorUrl = `${config.PDFGENERATOR_URL}/documents`;
const request = async (req, res, cb) => {
  try {
    await cb({
      organizationId: req.headers.organizationid,
      'Accept-Language': req.headers['accept-language'],
    });
  } catch (error) {
    res
      .status(error?.response?.status || 500)
      .json(error?.response?.data || {});
  }
};

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
const deprecatedGet = async (req, res) => {
  const { document, id, term } = req.params;
  let url = `${config.PDFGENERATOR_URL}/${document}/${id}`;
  if (term) {
    url = `${url}/${term}`;
  }

  const response = await axios.get(url, {
    responseType: 'stream',
    headers: {
      organizationId: req.headers.organizationid,
      'Accept-Language': req.headers['accept-language'],
    },
  });

  response.data.pipe(res);
};

const all = (req, res) => {
  request(req, res, async (headers) => {
    const response = await axios.get(pdfGeneratorUrl, { headers });

    res.json(response.data);
  });
};

const one = (req, res) => {
  request(req, res, async (headers) => {
    const { id } = req.params;

    const response = await axios.get(`${pdfGeneratorUrl}/${id}`, {
      headers,
    });

    res.json(response.data);
  });
};

const add = (req, res) => {
  request(req, res, async (headers) => {
    const response = await axios.post(pdfGeneratorUrl, req.body, {
      headers,
    });

    res.json(response.data);
  });
};

const update = (req, res) => {
  request(req, res, async (headers) => {
    const response = await axios.put(pdfGeneratorUrl, req.body, {
      headers,
    });

    res.json(response.data);
  });
};

const remove = (req, res) => {
  request(req, res, async (headers) => {
    const { ids } = req.params;

    const response = await axios.delete(`${pdfGeneratorUrl}/${ids}`, {
      headers,
    });

    res.json(response.data);
  });
};

module.exports = {
  deprecatedGet,
  all,
  one,
  add,
  update,
  remove,
};
