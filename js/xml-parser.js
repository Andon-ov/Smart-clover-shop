/**
 * XML Parser for Smart Clover Shop
 * Parses XML files from the warehouse system
 */

class XMLParser {
    /**
     * Load and parse XML file
     * @param {string} xmlPath - Path to XML file
     * @returns {Promise<Document>} Parsed XML document
     */
    static async loadXML(xmlPath) {
        try {
            const response = await fetch(xmlPath);
            const arrayBuffer = await response.arrayBuffer();
            
            // Decode as windows-1251 (files from EBOSyncModules)
            const decoder = new TextDecoder('windows-1251');
            const xmlText = decoder.decode(arrayBuffer);
            
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "text/xml");
            
            // Check for parsing errors
            const parserError = xmlDoc.querySelector('parsererror');
            if (parserError) {
                console.error('XML parsing error:', parserError);
                return null;
            }
            
            console.log('✓ XML loaded:', xmlPath);
            return xmlDoc;
        } catch (error) {
            console.error('Error loading XML:', error);
            return null;
        }
    }

    /**
     * Extract products from PLU XML (main product catalog)
     * @param {Document} xmlDoc - XML document
     * @returns {Array} Array of product objects
     */
    static extractProductsFromPLU(xmlDoc) {
        const products = [];
        const pluItems = xmlDoc.querySelectorAll('PLU');
        
        console.log(`Found ${pluItems.length} PLU items in XML`);
        
        pluItems.forEach((plu, index) => {
            const plunb = this.getTextContent(plu, 'PLUNB');
            const plunn = this.getTextContent(plu, 'PLUNN');
            const plunm = this.getTextContent(plu, 'PLUNM');
            const byprc = parseFloat(this.getTextContent(plu, 'BYPRC')) || 0;
            const slprc = parseFloat(this.getTextContent(plu, 'SLPRC')) || 0;
            const pqtty = parseFloat(this.getTextContent(plu, 'PQTTY')) || 0;
            const maxdisc = parseFloat(this.getTextContent(plu, 'MAXDISC')) || 0;
            const tax = parseFloat(this.getTextContent(plu, 'TAX')) || 0;
            const uom = this.getTextContent(plu, 'UOM');
            
            const grpElement = plu.querySelector('GRP');
            const groupName = grpElement ? this.getTextContent(grpElement, 'GNM') : '';
            
            const barcodeElement = plu.querySelector('BARCODES BRCD');
            const barcode = barcodeElement ? this.getTextContent(barcodeElement, 'BC') : '';
            
            if (plunb && plunm && slprc > 0) {
                const product = {
                    id: `${plunb}_${plunn}`,
                    code: plunn,
                    number: plunb,
                    name: plunm,
                    buyPrice: byprc,
                    sellPrice: slprc,
                    stock: Math.max(0, pqtty),
                    discount: maxdisc,
                    tax: tax,
                    currency: 'BGN',
                    uom: uom,
                    group: groupName,
                    barcode: barcode
                };
                
                if (index < 3) {
                    console.log('Sample product:', product);
                }
                
                products.push(product);
            }
        });
        
        console.log(`Extracted ${products.length} valid products from PLU`);
        return products;
    }

    /**
     * Extract products from POS sales XML
     * @param {Document} xmlDoc - XML document
     * @returns {Array} Array of product objects
     */
    static extractProductsFromPOSSales(xmlDoc) {
        const products = new Map();
        const receipts = xmlDoc.querySelectorAll('RECEIPT');
        
        receipts.forEach(receipt => {
            const pluItems = receipt.querySelectorAll('PLU');
            
            pluItems.forEach(plu => {
                const plunb = this.getTextContent(plu, 'PLUNB');
                const plunn = this.getTextContent(plu, 'PLUNN');
                const plunm = this.getTextContent(plu, 'PLUNM');
                const bprc = parseFloat(this.getTextContent(plu, 'BPRC')) || 0;
                const sprc = parseFloat(this.getTextContent(plu, 'SPRC')) || 0;
                const qty = parseFloat(this.getTextContent(plu, 'LQTY')) || 0;
                const disc = parseFloat(this.getTextContent(plu, 'DISC')) || 0;
                
                // Use unique product code as key
                const productKey = `${plunb}_${plunn}`;
                
                if (!products.has(productKey)) {
                    products.set(productKey, {
                        id: productKey,
                        code: plunn,
                        number: plunb,
                        name: plunm,
                        buyPrice: bprc,
                        sellPrice: sprc,
                        stock: qty,
                        discount: Math.abs(disc),
                        currency: 'BGN'
                    });
                }
            });
        });
        
        return Array.from(products.values());
    }

    /**
     * Extract customers from customers XML
     * @param {Document} xmlDoc - XML document
     * @returns {Array} Array of customer objects
     */
    static extractCustomers(xmlDoc) {
        const customers = [];
        const customerNodes = xmlDoc.querySelectorAll('CUSTOMER');
        
        customerNodes.forEach(customer => {
            const eik = this.getTextContent(customer, 'EIK');
            const name = this.getTextContent(customer, 'NAME');
            const town = this.getTextContent(customer, 'TOWN');
            const disc = parseFloat(this.getTextContent(customer, 'DISC')) || 0;
            
            customers.push({
                eik,
                name,
                town,
                discount: disc
            });
        });
        
        return customers;
    }

    /**
     * Get text content from XML element
     * @param {Element} parent - Parent XML element
     * @param {string} tagName - Tag name to search for
     * @returns {string} Text content
     */
    static getTextContent(parent, tagName) {
        const element = parent.querySelector(tagName);
        return element ? element.textContent.trim() : '';
    }

    /**
     * Extract customers from CUSTOMERS XML
     * @param {Document} xmlDoc - XML document
     * @returns {Array} Array of customer objects
     */
    static extractCustomers(xmlDoc) {
        const customers = [];
        const customerItems = xmlDoc.querySelectorAll('CUSTOMER');
        
        console.log(`Found ${customerItems.length} customers in XML`);
        
        customerItems.forEach((customer) => {
            const eik = this.getTextContent(customer, 'EIK');
            const name = this.getTextContent(customer, 'NAME');
            const phone = this.getTextContent(customer, 'PHONE');
            const email = this.getTextContent(customer, 'EMAIL');
            const town = this.getTextContent(customer, 'TOWN');
            const addr = this.getTextContent(customer, 'ADDR');
            
            // Build full address
            let fullAddress = '';
            if (town && addr) {
                fullAddress = `${town}, ${addr}`;
            } else if (addr) {
                fullAddress = addr;
            } else if (town) {
                fullAddress = town;
            }
            
            customers.push({
                id: eik || `CUST-${Date.now()}-${Math.random()}`,
                eik: eik,
                name: name || 'Неизвестен клиент',
                phone: phone || '',
                email: email || '',
                address: fullAddress,
                town: town || '',
                rawAddress: addr || ''
            });
        });
        
        return customers;
    }
}
