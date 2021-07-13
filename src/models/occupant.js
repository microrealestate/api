const OF = require('./objectfilter');
const Model = require('./model');

class OccupantModel extends Model {
  constructor() {
    super('occupants');
    this.schema = new OF({
      _id: String,
      isCompany: Boolean,
      company: String,
      legalForm: String,
      siret: String,
      capital: Number,
      manager: String,
      name: String,
      street1: String,
      street2: String,
      zipCode: String,
      city: String,
      state: String,
      country: String,
      contacts: Array,
      contract: String,
      leaseId: String,
      beginDate: String,
      endDate: String,
      frequency: String,
      terminationDate: String,
      guarantyPayback: Number,
      properties: Array, // [{ propertyId, property: { ... }, entryDate, exitDate, rent, expenses: [{title, amount}] }]
      guaranty: Number,
      reference: String,
      isVat: Boolean,
      vatRatio: Number,
      discount: Number,
      rents: Array,
    });
  }

  findAll(realm, callback) {
    super.findAll(realm, (errors, occupants) => {
      if (errors && errors.length > 0) {
        callback(errors);
        return;
      }

      callback(
        null,
        occupants.sort((o1, o2) => {
          const name1 = (o1.isCompany ? o1.company : o1.name) || '';
          const name2 = (o2.isCompany ? o2.company : o2.name) || '';

          return name1.localeCompare(name2);
        })
      );
    });
  }
}

module.exports = new OccupantModel();
