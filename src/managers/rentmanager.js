const logger = require('winston');
const axios = require('axios');
const moment = require('moment');
const Contract = require('./contract');
const FD = require('./frontdata');
const rentModel = require('../models/rent');
const occupantModel = require('../models/occupant');
const config = require('../config');

const _findOccupants = (realm, occupantId, startTerm, endTerm) => {
  return new Promise((resolve, reject) => {
    const filter = {
      $query: {
        $and: [],
      },
    };
    if (occupantId) {
      filter['$query']['$and'].push({ _id: occupantId });
    }
    if (startTerm && endTerm) {
      filter['$query']['$and'].push({ 'rents.term': { $gte: startTerm } });
      filter['$query']['$and'].push({ 'rents.term': { $lte: endTerm } });
    } else if (startTerm) {
      filter['$query']['$and'].push({ 'rents.term': startTerm });
    }
    occupantModel.findFilter(realm, filter, (errors, occupants) => {
      if (errors && errors.length > 0) {
        return reject(errors);
      }
      resolve(
        occupants
          .map((occupant) => {
            if (startTerm && endTerm) {
              occupant.rents = occupant.rents.filter(
                (rent) => rent.term >= startTerm && rent.term <= endTerm
              );
            } else if (startTerm) {
              occupant.rents = occupant.rents.filter(
                (rent) => rent.term === startTerm
              );
            }
            return occupant;
          })
          .sort((o1, o2) => {
            const name1 = o1.isCompany ? o1.company : o1.name;
            const name2 = o2.isCompany ? o2.company : o2.name;

            return name1.localeCompare(name2);
          })
      );
    });
  });
};

const _getEmailStatus = async (
  authorizationHeader,
  locale,
  realm,
  startTerm,
  endTerm
) => {
  try {
    let emailEndPoint = `${config.EMAILER_URL}/status/${startTerm}`;
    if (endTerm) {
      emailEndPoint = `${config.EMAILER_URL}/status/${startTerm}/${endTerm}`;
    }
    const response = await axios.get(emailEndPoint, {
      headers: {
        authorization: authorizationHeader,
        organizationid: String(realm._id),
        'Accept-Language': locale,
      },
    });
    logger.debug(response.data);
    return response.data.reduce((acc, status) => {
      const data = {
        sentTo: status.sentTo,
        sentDate: status.sentDate,
      };
      if (!acc[status.recordId]) {
        acc[status.recordId] = { [status.templateName]: [] };
      }
      let documents = acc[status.recordId][status.templateName];
      if (!documents) {
        documents = [];
        acc[status.recordId][status.templateName] = documents;
      }
      documents.push(data);
      return acc;
    }, {});
  } catch (error) {
    console.error(error);
    if (config.demoMode) {
      logger.info('email status fallback workflow activated in demo mode');
      return {};
    } else {
      throw error.data;
    }
  }
};

const _getRentsDataByTerm = async (
  authorizationHeader,
  locale,
  realm,
  currentDate,
  frequency
) => {
  const startTerm = Number(currentDate.startOf(frequency).format('YYYYMMDDHH'));
  const endTerm = Number(currentDate.endOf(frequency).format('YYYYMMDDHH'));

  const [dbOccupants, emailStatus = {}] = await Promise.all([
    _findOccupants(realm, null, startTerm, endTerm),
    _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      startTerm,
      endTerm
    ).catch(logger.error),
  ]);

  // compute rents
  const rents = dbOccupants.reduce((acc, occupant) => {
    acc.push(
      ...occupant.rents
        .filter((rent) => rent.term >= startTerm && rent.term <= endTerm)
        .map((rent) =>
          FD.toRentData(rent, occupant, emailStatus?.[occupant._id])
        )
    );
    return acc;
  }, []);

  // compute rents overview
  const overview = {
    countAll: 0,
    countPaid: 0,
    countPartiallyPaid: 0,
    countNotPaid: 0,
    totalToPay: 0,
    totalPaid: 0,
    totalNotPaid: 0,
  };
  rents.reduce((acc, rent) => {
    if (rent.totalAmount <= 0 || rent.newBalance >= 0) {
      acc.countPaid++;
    } else if (rent.payment > 0) {
      acc.countPartiallyPaid++;
    } else {
      acc.countNotPaid++;
    }
    acc.countAll++;
    acc.totalToPay += rent.totalToPay;
    acc.totalPaid += rent.payment;
    acc.totalNotPaid -= rent.newBalance;
    return acc;
  }, overview);

  return { overview, rents };
};

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
const update = async (req, res) => {
  const realm = req.realm;
  const paymentData = rentModel.paymentSchema.filter(req.body);
  const term = `01/${paymentData.month}/${paymentData.year} 00:00`;

  try {
    res.json(await _updateByTerm(realm, term, paymentData));
  } catch (errors) {
    console.error(errors);
    res.status(500).json({ errors });
  }
};

const updateByTerm = async (req, res) => {
  const realm = req.realm;
  const term = moment(req.params.term, 'YYYYMMDDHH').format('DD/MM/YYYY HH:00');
  const paymentData = rentModel.paymentSchema.filter(req.body);

  try {
    res.json(await _updateByTerm(realm, term, paymentData));
  } catch (errors) {
    console.error(errors);
    res.status(500).json({ errors });
  }
};

const _updateByTerm = async (realm, term, paymentData) => {
  if (!paymentData.promo && paymentData.promo <= 0) {
    paymentData.promo = 0;
    paymentData.notepromo = null;
  }

  if (!paymentData.extracharge && paymentData.extracharge <= 0) {
    paymentData.extracharge = 0;
    paymentData.noteextracharge = null;
  }

  const dbOccupant = await new Promise((resolve, reject) => {
    occupantModel.findOne(realm, paymentData._id, (errors, dbOccupant) => {
      if (errors && errors.length > 0) {
        return reject({ errors });
      }
      resolve(dbOccupant);
    });
  });

  const contract = {
    frequency: dbOccupant.frequency || 'months',
    begin: dbOccupant.beginDate,
    end: dbOccupant.endDate,
    discount: dbOccupant.discount || 0,
    vatRate: dbOccupant.vatRatio,
    properties: dbOccupant.properties,
    rents: dbOccupant.rents,
  };

  const settlements = {
    payments: [],
    debts: [],
    discounts: [],
    description: '',
  };

  if (paymentData) {
    if (paymentData.payments && paymentData.payments.length) {
      settlements.payments = paymentData.payments
        .filter(({ amount }) => amount && Number(amount) > 0)
        .map((payment) => ({
          date: payment.date || '',
          amount: Number(payment.amount),
          type: payment.type || '',
          reference: payment.reference || '',
          description: payment.description || '',
        }));
    }

    if (paymentData.promo) {
      settlements.discounts.push({
        origin: 'settlement',
        description: paymentData.notepromo || '',
        amount:
          paymentData.promo *
          (contract.vatRate ? 1 / (1 + contract.vatRate) : 1),
      });
    }

    if (paymentData.extracharge) {
      settlements.debts.push({
        description: paymentData.noteextracharge || '',
        amount:
          paymentData.extracharge *
          (contract.vatRate ? 1 / (1 + contract.vatRate) : 1),
      });
    }

    if (paymentData.description) {
      settlements.description = paymentData.description;
    }
  }

  dbOccupant.rents = Contract.payTerm(contract, term, settlements).rents;

  return await new Promise((resolve, reject) => {
    const termAsNumber = Number(
      moment(term, 'DD/MM/YYYY HH:00').format('YYYYMMDDHH')
    );
    occupantModel.update(realm, dbOccupant, (errors) => {
      if (errors) {
        return reject({ errors });
      }
      const rent = dbOccupant.rents.filter(
        (rent) => rent.term === termAsNumber
      )[0];
      resolve(FD.toRentData(rent, dbOccupant));
    });
  });
};

const rentsOfOccupant = async (req, res) => {
  const realm = req.realm;
  const { id } = req.params;
  const term = Number(moment().format('YYYYMMDDHH'));

  try {
    const dbOccupants = await _findOccupants(realm, id);
    if (!dbOccupants.length) {
      return res.sendStatus(404);
    }

    const dbOccupant = dbOccupants[0];
    const rentsToReturn = dbOccupant.rents.map((currentRent) => {
      const rent = FD.toRentData(currentRent);
      if (currentRent.term === term) {
        rent.active = 'active';
      }
      rent.vatRatio = dbOccupant.vatRatio;
      return rent;
    });

    res.json({
      occupant: FD.toOccupantData(dbOccupant),
      rents: rentsToReturn,
    });
  } catch (errors) {
    logger.error(errors);
    res.status(500).json({ errors });
  }
};

const rentOfOccupant = async (req, res) => {
  const realm = req.realm;
  const { id, month, year } = req.params;
  const term = Number(
    moment(`${month}/${year}`, 'MM/YYYY').startOf('month').format('YYYYMMDDHH')
  );
  try {
    res.json(
      await _rentOfOccupant(
        req.headers.authorization,
        req.headers['accept-language'],
        realm,
        id,
        term
      )
    );
  } catch (errors) {
    logger.error(errors);
    res.status(errors.status || 500).json({ errors });
  }
};

const rentOfOccupantByTerm = async (req, res) => {
  const realm = req.realm;
  const { id, term } = req.params;
  try {
    res.json(
      await _rentOfOccupant(
        req.headers.authorization,
        req.headers['accept-language'],
        realm,
        id,
        term
      )
    );
  } catch (errors) {
    res.status(errors.status || 500).json({ errors });
  }
};

const _rentOfOccupant = async (
  authorizationHeader,
  locale,
  realm,
  tenantId,
  term
) => {
  const [dbOccupants = [], emailStatus = {}] = await Promise.all([
    _findOccupants(realm, tenantId, Number(term)).catch(logger.error),
    _getEmailStatus(authorizationHeader, locale, realm, Number(term)).catch(
      logger.error
    ),
  ]);

  if (!dbOccupants.length) {
    throw { status: 404, error: 'tenant not found' };
  }
  const dbOccupant = dbOccupants[0];

  if (!dbOccupant.rents.length) {
    throw { status: 404, error: 'rent not found' };
  }
  const rent = FD.toRentData(
    dbOccupant.rents[0],
    dbOccupant,
    emailStatus?.[dbOccupant._id]
  );
  if (rent.term === Number(moment().format('YYYYMMDDHH'))) {
    rent.active = 'active';
  }
  rent.vatRatio = dbOccupant.vatRatio;

  return rent;
};

const all = async (req, res) => {
  const realm = req.realm;

  let currentDate = moment().startOf('month');
  if (req.params.year && req.params.month) {
    currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
  }

  try {
    res.json(
      await _getRentsDataByTerm(
        req.headers.authorization,
        req.headers['accept-language'],
        realm,
        currentDate,
        'months'
      )
    );
  } catch (errors) {
    logger.error(errors);
    res.status(500).json({ errors });
  }
};

const overview = async (req, res) => {
  try {
    const realm = req.realm;
    let currentDate = moment().startOf('month');
    if (req.params.year && req.params.month) {
      currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
    }

    const { overview } = await _getRentsDataByTerm(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      currentDate,
      'months'
    );
    res.json(overview);
  } catch (errors) {
    logger.error(errors);
    res.status(500).json({ errors });
  }
};

module.exports = {
  update,
  updateByTerm,
  rentsOfOccupant,
  rentOfOccupant,
  rentOfOccupantByTerm,
  all,
  overview,
};
