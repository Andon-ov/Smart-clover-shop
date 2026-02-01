/**
 * Main Application for Smart Clover Shop
 */

class ShopApp {
    constructor() {
        this.products = [];
        this.filteredProducts = [];
        this.displayedProducts = [];
        this.currentPage = 0;
        this.productsPerPage = 12;
        this.isLoading = false;
        this.cart = [];
        this.currentUser = null;
        this.init();
    }

    /**
     * Initialize the application
     */
    async init() {
        try {
            // Load customers from XML
            await this.loadCustomers();
            
            // Load saved user or show customer selection
            this.loadUser();
            
            this.loadCart();
            await this.loadProducts();
            this.setupEventListeners();
            this.setupInfiniteScroll();
            this.loadMoreProducts();
            this.updateCartUI();
        } catch (error) {
            console.error('Error initializing app:', error);
            this.showError();
        }
    }

    /**
     * Load customers from XML files
     */
    async loadCustomers() {
        this.customers = [];
        
        try {
            const xmlDoc = await XMLParser.loadXML('data/out/EboOut_CST.xml');
            if (xmlDoc) {
                this.customers = XMLParser.extractCustomers(xmlDoc);
                console.log(`✓ Loaded ${this.customers.length} customers`);
            }
        } catch (error) {
            console.warn('Could not load customers:', error);
            this.customers = [];
        }
    }

    /**
     * Load products from XML files
     */
    async loadProducts() {
        try {
            // Load from PLU XML (main product catalog)
            let xmlDoc = await XMLParser.loadXML('data/out/EboOut_PLU.xml');
            
            if (xmlDoc) {
                const pluProducts = XMLParser.extractProductsFromPLU(xmlDoc);
                if (pluProducts.length > 0) {
                    this.products = pluProducts;
                    console.log(`✓ Loaded ${this.products.length} products from PLU catalog`);
                }
            }
            
            // Try POS sales XML if PLU failed
            if (this.products.length === 0) {
                xmlDoc = await XMLParser.loadXML('data/out/EboOut_P.xml');
                
                if (xmlDoc) {
                    this.products = XMLParser.extractProductsFromPOSSales(xmlDoc);
                    if (this.products.length > 0) {
                        console.log(`✓ Loaded ${this.products.length} products from POS sales`);
                    }
                }
            }
            
            // Show error if no products loaded
            if (this.products.length === 0) {
                console.error('❌ No products found in any XML source');
                this.showNoProductsError();
            }
            
            this.filteredProducts = [...this.products];
            console.log(`Total products available: ${this.products.length}`);
        } catch (error) {
            console.error('Error loading products:', error);
            this.showNoProductsError();
        }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Search functionality
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.handleSearch(e.target.value);
            });
        }

        // Sort functionality
        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.handleSort(e.target.value);
            });
        }

        // Customer selection modal
        const customerModal = document.getElementById('customerSelectModal');
        if (customerModal) {
            customerModal.addEventListener('shown.bs.modal', () => {
                this.renderCustomerList();
            });
        }
    }

    /**
     * Setup infinite scroll
     */
    setupInfiniteScroll() {
        const scrollToTopBtn = document.getElementById('scrollToTop');
        
        window.addEventListener('scroll', () => {
            // Show/hide scroll to top button
            if (scrollToTopBtn) {
                if (window.pageYOffset > 300) {
                    scrollToTopBtn.classList.add('show');
                } else {
                    scrollToTopBtn.classList.remove('show');
                }
            }
            
            // Lazy loading
            if (this.isLoading) return;
            
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollHeight = document.documentElement.scrollHeight;
            const clientHeight = document.documentElement.clientHeight;
            
            // Load more when user is 300px from bottom
            if (scrollTop + clientHeight >= scrollHeight - 300) {
                this.loadMoreProducts();
            }
        });
    }

    /**
     * Handle search functionality
     */
    handleSearch(searchTerm) {
        const term = searchTerm.toLowerCase().trim();
        
        if (term === '') {
            this.filteredProducts = [...this.products];
        } else {
            this.filteredProducts = this.products.filter(product => {
                return product.name.toLowerCase().includes(term) ||
                       product.code.toLowerCase().includes(term) ||
                       product.number.toLowerCase().includes(term);
            });
        }
        
        this.resetDisplay();
    }

    /**
     * Handle sort functionality
     */
    handleSort(sortType) {
        let sorted = [...this.filteredProducts];
        
        switch(sortType) {
            case 'price-asc':
                sorted.sort((a, b) => a.sellPrice - b.sellPrice);
                break;
            case 'price-desc':
                sorted.sort((a, b) => b.sellPrice - a.sellPrice);
                break;
            case 'name-asc':
                sorted.sort((a, b) => a.name.localeCompare(b.name, 'bg'));
                break;
            case 'name-desc':
                sorted.sort((a, b) => b.name.localeCompare(a.name, 'bg'));
                break;
            default:
                sorted = [...this.filteredProducts];
        }
        
        this.filteredProducts = sorted;
        this.resetDisplay();
    }

    /**
     * Reset display and load first page
     */
    resetDisplay() {
        this.currentPage = 0;
        this.displayedProducts = [];
        const productsGrid = document.getElementById('productsGrid');
        if (productsGrid) {
            productsGrid.innerHTML = '';
        }
        this.loadMoreProducts();
    }

    /**
     * Load more products (pagination/infinite scroll)
     */
    loadMoreProducts() {
        if (this.isLoading) return;
        
        const startIndex = this.currentPage * this.productsPerPage;
        const endIndex = startIndex + this.productsPerPage;
        
        // Check if there are more products to load
        if (startIndex >= this.filteredProducts.length) {
            this.hideLoadingSpinner();
            return;
        }
        
        this.isLoading = true;
        this.showLoadingSpinner();
        
        // Simulate slight delay for smooth loading
        setTimeout(() => {
            const newProducts = this.filteredProducts.slice(startIndex, endIndex);
            this.displayedProducts.push(...newProducts);
            this.appendProducts(newProducts);
            this.currentPage++;
            this.isLoading = false;
            this.updateProductCount();
            
            // Hide loading spinner if all products are loaded
            if (endIndex >= this.filteredProducts.length) {
                this.hideLoadingSpinner();
            }
        }, 300);
    }

    /**
     * Append products to the grid (for lazy loading)
     */
    appendProducts(products) {
        const productsGrid = document.getElementById('productsGrid');
        const noResults = document.getElementById('noResults');
        
        if (products.length === 0 && this.displayedProducts.length === 0) {
            if (noResults) {
                noResults.classList.remove('d-none');
            }
            return;
        }
        
        if (noResults) {
            noResults.classList.add('d-none');
        }
        
        // Append product cards to grid
        products.forEach(product => {
            const card = this.createProductCard(product);
            productsGrid.appendChild(card);
        });
    }

    /**
     * Update product count display
     */
    updateProductCount() {
        const productCount = document.getElementById('productCount');
        if (productCount) {
            const count = this.displayedProducts.length;
            productCount.textContent = `${count} ${count === 1 ? 'продукт' : 'продукта'}`;
        }
    }

    /**
     * Show loading spinner
     */
    showLoadingSpinner() {
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.style.display = 'block';
        }
    }

    /**
     * Hide loading spinner
     */
    hideLoadingSpinner() {
        const loadingSpinner = document.getElementById('loadingSpinner');
        if (loadingSpinner) {
            loadingSpinner.style.display = 'none';
        }
    }

    /**
     * Display products on the page
     */
    displayProducts(products) {
        const productsGrid = document.getElementById('productsGrid');
        const loadingSpinner = document.getElementById('loadingSpinner');
        const noResults = document.getElementById('noResults');
        const productCount = document.getElementById('productCount');
        
        // Hide loading spinner
        if (loadingSpinner) {
            loadingSpinner.style.display = 'none';
        }
        
        // Update product count
        if (productCount) {
            const count = products.length;
            productCount.textContent = `${count} ${count === 1 ? 'продукт' : 'продукта'}`;
        }
        
        // Clear grid
        productsGrid.innerHTML = '';
        
        // Show no results message if needed
        if (products.length === 0) {
            if (noResults) {
                noResults.classList.remove('d-none');
            }
            return;
        }
        
        if (noResults) {
            noResults.classList.add('d-none');
        }
        
        // Create product cards
        products.forEach(product => {
            const card = this.createProductCard(product);
            productsGrid.appendChild(card);
        });
    }

    /**
     * Create product card HTML element
     */
    createProductCard(product) {
        const col = document.createElement('div');
        col.className = 'col-md-6 col-lg-4 col-xl-3';
        
        const finalPrice = product.discount > 0 
            ? product.sellPrice * (1 - product.discount / 100)
            : product.sellPrice;
        
        const stockStatus = this.getStockStatus(product.stock);
        const stockClass = stockStatus.class;
        const stockText = stockStatus.text;
        const stockIcon = stockStatus.icon;
        
        col.innerHTML = `
            <div class="card product-card h-100">
                ${product.discount > 0 ? `<span class="badge-discount">-${product.discount}%</span>` : ''}
                <div class="product-image">
                    <i class="bi bi-box-seam"></i>
                </div>
                <div class="card-body d-flex flex-column">
                    <h5 class="product-title">${this.escapeHtml(product.name)}</h5>
                    <p class="product-code mb-2">
                        <i class="bi bi-upc"></i> Код: ${this.escapeHtml(product.code)}
                    </p>
                    <div class="mt-auto">
                        <div class="mb-2">
                            ${product.discount > 0 ? `
                                <span class="product-old-price">${product.sellPrice.toFixed(2)} ${product.currency}</span>
                            ` : ''}
                            <div class="product-price">
                                ${finalPrice.toFixed(2)} ${product.currency}
                            </div>
                        </div>
                        <div class="product-stock ${stockClass}">
                            <i class="bi ${stockIcon}"></i> ${stockText}
                        </div>
                        <div class="d-grid gap-2 mt-3">
                            <button class="btn btn-success" onclick="shopApp.addToCart('${product.id}')">
                                <i class="bi bi-cart-plus"></i> Добави в кошницата
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        return col;
    }

    /**
     * Get stock status
     */
    getStockStatus(stock) {
        if (stock > 100) {
            return {
                class: 'in-stock',
                text: `В наличност (${stock} бр.)`,
                icon: 'bi-check-circle-fill'
            };
        } else if (stock > 0) {
            return {
                class: 'low-stock',
                text: `Ограничена наличност (${stock} бр.)`,
                icon: 'bi-exclamation-triangle-fill'
            };
        } else {
            return {
                class: 'out-of-stock',
                text: 'Изчерпан',
                icon: 'bi-x-circle-fill'
            };
        }
    }

    /**
     * View product details (placeholder for future functionality)
     */
    viewProductDetails(productId) {
        const product = this.products.find(p => p.id === productId);
        if (product) {
            alert(`Детайли за продукт:\n\nНаименование: ${product.name}\nКод: ${product.code}\nЦена: ${product.sellPrice.toFixed(2)} ${product.currency}\nНаличност: ${product.stock} бр.`);
        }
    }

    /**
     * Add product to cart
     */
    addToCart(productId) {
        const product = this.products.find(p => p.id === productId);
        if (!product) return;

        const existingItem = this.cart.find(item => item.id === productId);
        
        if (existingItem) {
            if (existingItem.quantity < product.stock) {
                existingItem.quantity++;
            } else {
                alert('Няма достатъчна наличност!');
                return;
            }
        } else {
            this.cart.push({
                ...product,
                quantity: 1
            });
        }

        this.saveCart();
        this.updateCartUI();
        this.showNotification(`${product.name} беше добавен в кошницата!`);
    }

    /**
     * Remove product from cart
     */
    removeFromCart(productId) {
        this.cart = this.cart.filter(item => item.id !== productId);
        this.saveCart();
        this.updateCartUI();
        this.renderCartItems();
    }

    /**
     * Update cart item quantity
     */
    updateCartQuantity(productId, quantity) {
        const item = this.cart.find(item => item.id === productId);
        if (item) {
            const product = this.products.find(p => p.id === productId);
            if (quantity <= 0) {
                this.removeFromCart(productId);
            } else if (quantity <= product.stock) {
                item.quantity = quantity;
                this.saveCart();
                this.updateCartUI();
                this.renderCartItems();
            } else {
                alert('Няма достатъчна наличност!');
            }
        }
    }

    /**
     * Save cart to localStorage
     */
    saveCart() {
        localStorage.setItem('cart', JSON.stringify(this.cart));
    }

    /**
     * Load cart from localStorage
     */
    loadCart() {
        const savedCart = localStorage.getItem('cart');
        if (savedCart) {
            this.cart = JSON.parse(savedCart);
        }
    }

    /**
     * Update cart UI (badge counter)
     */
    updateCartUI() {
        const cartCount = document.getElementById('cartCount');
        const totalItems = this.cart.reduce((sum, item) => sum + item.quantity, 0);
        if (cartCount) {
            cartCount.textContent = totalItems;
            cartCount.style.display = totalItems > 0 ? 'inline' : 'none';
        }
    }

    /**
     * Load user from localStorage
     */
    loadUser() {
        const savedUser = localStorage.getItem('currentUser');
        if (savedUser) {
            const user = JSON.parse(savedUser);
            
            // Validate that user exists in customers list (loaded from XML)
            const customerExists = this.customers && this.customers.find(c => c.id === user.id);
            
            if (customerExists) {
                this.currentUser = user;
                this.updateUserUI();
                console.log('✓ Loaded saved customer:', user.name);
            } else {
                // User doesn't exist in XML - clear it
                console.warn('⚠ Saved customer not found in XML, clearing...');
                localStorage.removeItem('currentUser');
                this.currentUser = null;
                this.updateUserUI();
            }
        } else {
            // No saved user - customer must select from list
            this.currentUser = null;
            this.updateUserUI();
        }
    }

    /**
     * Save user to localStorage
     */
    saveUser(user) {
        this.currentUser = user;
        localStorage.setItem('currentUser', JSON.stringify(user));
        this.updateUserUI();
    }

    /**
     * Update user UI
     */
    updateUserUI() {
        const userDisplay = document.getElementById('userDisplay');
        
        if (!userDisplay) return;
        
        if (this.currentUser) {
            userDisplay.innerHTML = `
                <span class="text-white">
                    <i class="bi bi-person-circle me-1"></i>
                    <strong>${this.escapeHtml(this.currentUser.name)}</strong>
                </span>
            `;
        } else {
            userDisplay.innerHTML = `
                <button class="btn btn-outline-light btn-sm" data-bs-toggle="modal" data-bs-target="#customerSelectModal">
                    <i class="bi bi-person-plus me-1"></i>
                    Избери клиент
                </button>
            `;
        }
    }

    /**
     * Login/Register user
     */
    loginUser(name, phone, email, address) {
        const user = {
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            address: address.trim(),
            createdAt: new Date().toISOString()
        };
        
        this.saveUser(user);
        
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('userModal'));
        if (modal) modal.hide();
        
        this.showNotification('Успешен вход!');
    }

    /**
     * Logout user
     */
    logout() {
        this.currentUser = null;
        localStorage.removeItem('currentUser');
        this.updateUserUI();
        this.showNotification('Излязохте от профила си.');
    }

    /**
     * Show customer selection modal
     */
    showCustomerSelect() {
        this.renderCustomerList();
        const customerModal = new bootstrap.Modal(document.getElementById('customerSelectModal'));
        customerModal.show();
        
        // Setup search
        const searchInput = document.getElementById('customerSearch');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.filterCustomers(e.target.value);
            });
        }
    }

    /**
     * Render customer list
     */
    renderCustomerList(filter = '') {
        const customerList = document.getElementById('customerList');
        
        if (!customerList) return;
        
        let filtered = this.customers || [];
        
        if (filter) {
            const term = filter.toLowerCase();
            filtered = filtered.filter(c => 
                c.name.toLowerCase().includes(term) ||
                c.phone.includes(term) ||
                c.email.toLowerCase().includes(term) ||
                c.eik.includes(term)
            );
        }
        
        if (filtered.length === 0) {
            customerList.innerHTML = '<div class="text-center text-muted p-4">Няма намерени клиенти</div>';
            return;
        }
        
        customerList.innerHTML = filtered.map(customer => `
            <button type="button" class="list-group-item list-group-item-action" onclick="shopApp.selectCustomer('${customer.id}')">
                <div class="d-flex w-100 justify-content-between">
                    <h6 class="mb-1">${this.escapeHtml(customer.name)}</h6>
                    <small class="text-muted">${this.escapeHtml(customer.eik)}</small>
                </div>
                <p class="mb-1">
                    <i class="bi bi-telephone"></i> ${this.escapeHtml(customer.phone)}
                    ${customer.email ? `<span class="ms-3"><i class="bi bi-envelope"></i> ${this.escapeHtml(customer.email)}</span>` : ''}
                </p>
                ${customer.address ? `<small class="text-muted"><i class="bi bi-geo-alt"></i> ${this.escapeHtml(customer.address)}</small>` : ''}
            </button>
        `).join('');
    }

    /**
     * Filter customers
     */
    filterCustomers(searchTerm) {
        this.renderCustomerList(searchTerm);
    }

    /**
     * Select customer
     */
    selectCustomer(customerId) {
        const customer = this.customers.find(c => c.id === customerId);
        
        if (!customer) {
            alert('Клиентът не е намерен!');
            return;
        }
        
        // Create user from customer
        const user = {
            id: customer.id,
            eik: customer.eik,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            address: customer.address,
            town: customer.town || '',
            addr: customer.rawAddress || '',
            createdAt: new Date().toISOString()
        };
        
        this.saveUser(user);
        
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('customerSelectModal'));
        if (modal) modal.hide();
        
        this.showNotification(`Избрахте клиент: ${customer.name}`);
    }

    /**
     * Show cart modal
     */
    showCart() {
        this.renderCartItems();
        const cartModal = new bootstrap.Modal(document.getElementById('cartModal'));
        cartModal.show();
    }

    /**
     * Render cart items
     */
    renderCartItems() {
        const cartItemsContainer = document.getElementById('cartItems');
        const cartTotal = document.getElementById('cartTotal');
        
        if (this.cart.length === 0) {
            cartItemsContainer.innerHTML = '<p class="text-center text-muted">Кошницата е празна</p>';
            cartTotal.textContent = '0.00';
            return;
        }
        
        let total = 0;
        cartItemsContainer.innerHTML = this.cart.map(item => {
            const itemTotal = item.sellPrice * item.quantity;
            total += itemTotal;
            
            return `
                <div class="cart-item mb-3 p-3 border rounded">
                    <div class="row align-items-center">
                        <div class="col-md-6">
                            <h6>${this.escapeHtml(item.name)}</h6>
                            <small class="text-muted">Код: ${this.escapeHtml(item.code)}</small>
                        </div>
                        <div class="col-md-3">
                            <div class="input-group input-group-sm">
                                <button class="btn btn-outline-secondary" onclick="shopApp.updateCartQuantity('${item.id}', ${item.quantity - 1})">-</button>
                                <input type="number" class="form-control text-center" value="${item.quantity}" min="1" max="${item.stock}" 
                                    onchange="shopApp.updateCartQuantity('${item.id}', parseInt(this.value))">
                                <button class="btn btn-outline-secondary" onclick="shopApp.updateCartQuantity('${item.id}', ${item.quantity + 1})">+</button>
                            </div>
                        </div>
                        <div class="col-md-2 text-end">
                            <strong>${itemTotal.toFixed(2)} BGN</strong>
                        </div>
                        <div class="col-md-1 text-end">
                            <button class="btn btn-sm btn-danger" onclick="shopApp.removeFromCart('${item.id}')">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        cartTotal.textContent = total.toFixed(2);
    }

    /**
     * Proceed to checkout
     */
    proceedToCheckout() {
        if (!this.currentUser) {
            alert('Моля, влезте в профила си преди да направите поръчка.');
            const modal = bootstrap.Modal.getInstance(document.getElementById('cartModal'));
            if (modal) modal.hide();
            
            const userModal = new bootstrap.Modal(document.getElementById('userModal'));
            userModal.show();
            return;
        }
        
        if (this.cart.length === 0) {
            alert('Кошницата е празна!');
            return;
        }
        
        // Close cart modal
        const cartModal = bootstrap.Modal.getInstance(document.getElementById('cartModal'));
        if (cartModal) cartModal.hide();
        
        // Show checkout modal
        this.renderCheckout();
        const checkoutModal = new bootstrap.Modal(document.getElementById('checkoutModal'));
        checkoutModal.show();
    }

    /**
     * Render checkout form
     */
    renderCheckout() {
        const checkoutItems = document.getElementById('checkoutItems');
        const checkoutTotal = document.getElementById('checkoutTotal');
        
        let total = 0;
        checkoutItems.innerHTML = this.cart.map(item => {
            const itemTotal = item.sellPrice * item.quantity;
            total += itemTotal;
            
            return `
                <tr>
                    <td>${this.escapeHtml(item.name)}</td>
                    <td class="text-center">${item.quantity}</td>
                    <td class="text-end">${item.sellPrice.toFixed(2)} BGN</td>
                    <td class="text-end"><strong>${itemTotal.toFixed(2)} BGN</strong></td>
                </tr>
            `;
        }).join('');
        
        checkoutTotal.textContent = total.toFixed(2);
        
        // Fill user info
        document.getElementById('orderName').value = this.currentUser.name;
        document.getElementById('orderPhone').value = this.currentUser.phone;
        document.getElementById('orderEmail').value = this.currentUser.email;
        document.getElementById('orderAddress').value = this.currentUser.address;
    }

    /**
     * Submit order
     */
    async submitOrder() {
        // Validate that user is selected and has required data
        if (!this.currentUser || !this.currentUser.name) {
            alert('Моля, изберете клиент преди да направите поръчка!');
            const modal = bootstrap.Modal.getInstance(document.getElementById('checkoutModal'));
            if (modal) modal.hide();
            this.showCustomerSelect();
            return;
        }
        
        const notes = document.getElementById('orderNotes').value;
        
        const order = {
            id: 'ORD-' + Date.now(),
            date: new Date().toISOString(),
            customer: this.currentUser,
            items: this.cart.map(item => ({
                productId: item.id,
                number: item.number,
                code: item.code,
                name: item.name,
                quantity: item.quantity,
                price: item.sellPrice,
                total: item.sellPrice * item.quantity
            })),
            total: this.cart.reduce((sum, item) => sum + (item.sellPrice * item.quantity), 0),
            notes: notes,
            status: 'pending'
        };
        
        // Generate XML for warehouse system
        await this.generateOrderXML(order);
        
        // Save order to localStorage
        this.saveOrder(order);
        
        // Clear cart
        this.cart = [];
        this.saveCart();
        this.updateCartUI();
        
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('checkoutModal'));
        if (modal) modal.hide();
        
        this.showNotification('Поръчката е създадена успешно! Копирайте XML файла от Downloads в D:\\EBOSyncModules\\Transfer\\');
    }

    /**
     * Generate XML order file in RDELIV format (correct format for EboIn imports)
     * Според официалната документация: "5. Входящи документи" - RDELIV формат
     */
    async generateOrderXML(order) {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, ''); // HHMMSS
        
        // Extract numeric part from order.id (remove "ORD-" prefix)
        // DNMB MUST be a number AND fit in INT32 (max 2147483647)
        // Use only last 9 digits from timestamp to avoid overflow
        const fullNumber = order.id.replace('ORD-', '');
        const orderNumber = parseInt(fullNumber.slice(-9));
        
        // Generate RDELIV format - ПРАВИЛНИЯТ формат за EboIn входящи документи!
        // TYP=1 означава "заявка за доставка" (delivery request)
        // ВАЖНО: SEIK (ЕИК на контрагента) е ЗАДЪЛЖИТЕЛЕН!
        // ВАЖНО: DNMB ТРЯБВА да бъде число И да е по-малко от 2147483647 (INT32)!
        const xml = `<?xml version="1.0" encoding="WINDOWS-1251"?>
<RDELIV>
  <REQD>
    <TYP>1</TYP>
    <SEIK>${order.customer.eik || ''}</SEIK>
    <DNMB>${orderNumber}</DNMB>
    <CMNT>${order.notes ? this.escapeXml(order.notes) : 'Онлайн поръчка'} [REF: ${order.id}]</CMNT>
    <DDATE>${dateStr}</DDATE>
    <DTIME>${timeStr}</DTIME>
    <STORG>1</STORG>
    <PLUES>
${order.items.map(item => `      <PLU>
        <PLUNB>${item.number}</PLUNB>
        <PLUNN>${this.escapeXml(item.code)}</PLUNN>
        <QTY>${item.quantity.toFixed(3)}</QTY>
        <PRC>${item.price.toFixed(2)}</PRC>
        <CURR>BGN</CURR>
        <PCMNT></PCMNT>
      </PLU>`).join('\n')}
    </PLUES>
  </REQD>
</RDELIV>`;
        
        const filename = `EboIn_Order_${order.id}_${dateStr}-${timeStr}.xml`;
        
        // Create proper windows-1251 encoded file
        // Note: Browser may not perfectly preserve windows-1251, 
        // but we declare it in XML header for system compatibility
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(xml);
        
        // Download file directly (no server needed)
        const blob = new Blob([utf8Bytes], { type: 'text/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('✓ Order XML downloaded:', filename);
        console.log('📝 Location: Downloads folder');
        console.log('⚠ ВАЖНО: Копирайте файла в D:\\EBOSyncModules\\Transfer\\');
    }

    /**
     * Save order to localStorage
     */
    saveOrder(order) {
        const orders = JSON.parse(localStorage.getItem('orders') || '[]');
        orders.push(order);
        localStorage.setItem('orders', JSON.stringify(orders));
    }

    /**
     * Show notification
     */
    showNotification(message) {
        // Create toast element if it doesn't exist
        let toastContainer = document.getElementById('toastContainer');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'toastContainer';
            toastContainer.className = 'position-fixed top-0 end-0 p-3';
            toastContainer.style.zIndex = '11';
            document.body.appendChild(toastContainer);
        }
        
        const toastId = 'toast-' + Date.now();
        const toastHTML = `
            <div id="${toastId}" class="toast" role="alert">
                <div class="toast-header bg-success text-white">
                    <i class="bi bi-check-circle me-2"></i>
                    <strong class="me-auto">Успех</strong>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast"></button>
                </div>
                <div class="toast-body">
                    ${message}
                </div>
            </div>
        `;
        
        toastContainer.insertAdjacentHTML('beforeend', toastHTML);
        const toastElement = document.getElementById(toastId);
        const toast = new bootstrap.Toast(toastElement, { delay: 3000 });
        toast.show();
        
        toastElement.addEventListener('hidden.bs.toast', () => {
            toastElement.remove();
        });
    }

    /**
     * Escape XML special characters
     */
    escapeXml(text) {
        if (!text) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Show error when no products are available
     */
    showNoProductsError() {
        const productsGrid = document.getElementById('productsGrid');
        const loadingSpinner = document.getElementById('loadingSpinner');
        
        if (loadingSpinner) {
            loadingSpinner.style.display = 'none';
        }
        
        if (productsGrid) {
            productsGrid.innerHTML = `
                <div class="col-12">
                    <div class="alert alert-warning text-center" role="alert">
                        <i class="bi bi-exclamation-triangle-fill fs-1 mb-3 d-block"></i>
                        <h4 class="alert-heading">Няма налични продукти</h4>
                        <p class="mb-3">Моля, уверете се че:</p>
                        <ul class="list-unstyled">
                            <li>✓ XML файлът <code>EboOut_PLU.xml</code> съществува в <code>data/out/</code></li>
                            <li>✓ Файлът съдържа валидни продуктни данни</li>
                            <li>✓ Кодировката е <code>windows-1251</code></li>
                        </ul>
                        <hr>
                        <p class="mb-0">
                            <a href="#" onclick="location.reload()" class="btn btn-primary">
                                <i class="bi bi-arrow-clockwise"></i> Опитай отново
                            </a>
                        </p>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Show error message
     */
    showError() {
        const productsGrid = document.getElementById('productsGrid');
        const loadingSpinner = document.getElementById('loadingSpinner');
        
        if (loadingSpinner) {
            loadingSpinner.style.display = 'none';
        }
        
        productsGrid.innerHTML = `
            <div class="col-12 text-center">
                <div class="alert alert-danger" role="alert">
                    <i class="bi bi-exclamation-triangle"></i>
                    Възникна грешка при зареждане на продуктите. Моля, опитайте отново по-късно.
                </div>
            </div>
        `;
    }
}

// Initialize the app when DOM is loaded
let shopApp;
document.addEventListener('DOMContentLoaded', () => {
    shopApp = new ShopApp();
});
