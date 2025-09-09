// Databricks SQL Configuration
// Copy this file to config.js and fill in your actual values

module.exports = {
  databricks: {
    // Your Databricks workspace hostname (e.g., adb-1234567890123456.7.azuredatabricks.net)
    serverHostname: 'your-databricks-hostname',
    
    // Your SQL warehouse HTTP path (e.g., /sql/1.0/warehouses/1234567890abcdef)
    httpPath: '/sql/1.0/warehouses/your-warehouse-id',
    
    // Your Databricks personal access token
    accessToken: 'your-access-token'
  },
  
  // Database table configuration
  database: {
    // Table name containing employee data
    employeesTable: 'employees',
    
    // Column names in the employees table
    emailColumn: 'email',
    startDateColumn: 'start_date'
  }
};
